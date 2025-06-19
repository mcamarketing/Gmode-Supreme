#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const BloXrouteConnector = require('./bloxroute-connector');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/flash-arbitrage.log' }),
    new winston.transports.Console()
  ]
});

class FlashLoanArbitrageEngine {
  constructor() {
    this.bloxroute = new BloXrouteConnector();
    this.provider = null;
    this.wallet = null;
    this.flashEngine = null;
    
    // Flash loan configuration
    this.config = {
      venusUnitroller: process.env.VENUS_UNITROLLER,
      venusVBNB: process.env.VENUS_VBNB,
      flashLoanFee: parseFloat(process.env.FLASH_LOAN_FEE) || 0.0009, // 0.09%
      maxFlashLoanAmount: parseFloat(process.env.MAX_FLASH_LOAN_AMOUNT) || 1000,
      minFlashLoanProfit: parseFloat(process.env.MIN_FLASH_LOAN_PROFIT) || 0.05,
      dynamicSizing: process.env.DYNAMIC_LOAN_SIZING === 'true',
      maxRetries: parseInt(process.env.FLASH_LOAN_RETRY_ATTEMPTS) || 3
    };
    
    // DEX configurations
    this.dexes = {
      pancakeV2: {
        router: process.env.PANCAKESWAP_ROUTER_V2,
        factory: process.env.PANCAKESWAP_FACTORY_V2,
        fee: 0.0025 // 0.25%
      },
      biswap: {
        router: process.env.BISWAP_ROUTER,
        fee: 0.001 // 0.1%
      },
      apeswap: {
        router: process.env.APESWAP_ROUTER,
        fee: 0.002 // 0.2%
      },
      bakery: {
        router: process.env.BAKERYSWAP_ROUTER,
        fee: 0.003 // 0.3%
      },
      mdex: {
        router: process.env.MDEX_ROUTER,
        fee: 0.003 // 0.3%
      }
    };
    
    // Performance metrics
    this.metrics = {
      totalFlashLoans: 0,
      successfulFlashLoans: 0,
      totalProfit: 0,
      largestProfit: 0,
      averageProfit: 0,
      gasUsed: 0
    };
    
    // Active opportunities
    this.activeOpportunities = new Map();
    this.priceCache = new Map();
  }

  async initialize() {
    logger.info('🔥 Initializing Flash Loan Arbitrage Engine...');
    
    // Initialize BloXroute
    await this.bloxroute.initialize();
    
    // Setup provider
    this.provider = new ethers.providers.JsonRpcProvider(
      process.env.FALLBACK_RPC_URLS.split(',')[0]
    );
    
    // Setup wallet
    this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
    logger.info(`🔑 Flash loan wallet: ${this.wallet.address}`);
    
    // Check if flash engine is deployed
    if (process.env.FLASH_ENGINE_ADDRESS && process.env.FLASH_ENGINE_ADDRESS !== '0x0000000000000000000000000000000000000000') {
      this.flashEngine = new ethers.Contract(
        process.env.FLASH_ENGINE_ADDRESS,
        this.getFlashEngineABI(),
        this.wallet
      );
      logger.info(`⚡ Flash Engine deployed at: ${process.env.FLASH_ENGINE_ADDRESS}`);
    }
    
    // Setup BloXroute listeners
    this.setupBloXrouteListeners();
    
    // Start opportunity scanning
    this.startOpportunityScanning();
    
    return true;
  }

  setupBloXrouteListeners() {
    // Listen for large trades that might create arbitrage opportunities
    this.bloxroute.on('pendingTransaction', async (tx) => {
      await this.analyzeForArbitrageOpportunity(tx);
    });
    
    // Listen for new blocks to update prices
    this.bloxroute.on('newBlock', async (block) => {
      await this.updatePriceCache();
    });
  }

  async analyzeForArbitrageOpportunity(tx) {
    try {
      // Check if it's a large swap that might move prices
      if (!this.isLargeSwap(tx)) return;
      
      // Identify the token pair
      const { tokenA, tokenB, amountIn } = await this.decodeLargeSwap(tx);
      if (!tokenA || !tokenB) return;
      
      // Calculate potential arbitrage after this trade executes
      const opportunity = await this.calculateFlashArbitrageOpportunity(tokenA, tokenB, amountIn);
      
      if (opportunity && opportunity.profit > this.config.minFlashLoanProfit) {
        logger.info(`💰 Flash arbitrage opportunity: ${opportunity.profit.toFixed(4)} BNB profit`);
        await this.executeFlashArbitrage(opportunity);
      }
      
    } catch (error) {
      // Ignore errors for speed
    }
  }

  async calculateFlashArbitrageOpportunity(tokenA, tokenB, impactAmount) {
    try {
      // Get prices across all DEXs
      const prices = {};
      
      for (const [dexName, dexConfig] of Object.entries(this.dexes)) {
        try {
          const price = await this.getTokenPrice(dexConfig.router, tokenA, tokenB, ethers.utils.parseEther('1'));
          if (price) {
            prices[dexName] = {
              price,
              fee: dexConfig.fee,
              router: dexConfig.router
            };
          }
        } catch {
          // Skip if pair doesn't exist on this DEX
        }
      }
      
      // Find best arbitrage opportunity
      const arbitrage = this.findBestArbitrage(prices, tokenA, tokenB);
      
      if (!arbitrage) return null;
      
      // Calculate optimal flash loan size
      const optimalSize = this.calculateOptimalFlashLoanSize(arbitrage, impactAmount);
      
      // Estimate total profit after fees
      const grossProfit = arbitrage.profitPercent * optimalSize / 100;
      const flashLoanFee = optimalSize * this.config.flashLoanFee;
      const gasCost = await this.estimateGasCost();
      const netProfit = grossProfit - flashLoanFee - gasCost;
      
      if (netProfit > this.config.minFlashLoanProfit) {
        return {
          tokenA,
          tokenB,
          buyDex: arbitrage.buyDex,
          sellDex: arbitrage.sellDex,
          flashLoanSize: optimalSize,
          profit: netProfit,
          profitPercent: arbitrage.profitPercent,
          timestamp: Date.now()
        };
      }
      
      return null;
    } catch (error) {
      logger.error('Error calculating arbitrage:', error);
      return null;
    }
  }

  findBestArbitrage(prices, tokenA, tokenB) {
    const dexes = Object.keys(prices);
    if (dexes.length < 2) return null;
    
    let bestArbitrage = null;
    let maxProfit = 0;
    
    // Compare all DEX pairs
    for (let i = 0; i < dexes.length; i++) {
      for (let j = i + 1; j < dexes.length; j++) {
        const dex1 = dexes[i];
        const dex2 = dexes[j];
        
        const price1 = prices[dex1].price;
        const price2 = prices[dex2].price;
        const fee1 = prices[dex1].fee;
        const fee2 = prices[dex2].fee;
        
        // Calculate profit in both directions
        const profit1to2 = ((price2 - price1) / price1 * 100) - (fee1 + fee2) * 100;
        const profit2to1 = ((price1 - price2) / price2 * 100) - (fee1 + fee2) * 100;
        
        if (profit1to2 > maxProfit && profit1to2 > 0.1) { // Min 0.1% profit
          maxProfit = profit1to2;
          bestArbitrage = {
            buyDex: dex1,
            sellDex: dex2,
            profitPercent: profit1to2,
            buyPrice: price1,
            sellPrice: price2
          };
        }
        
        if (profit2to1 > maxProfit && profit2to1 > 0.1) {
          maxProfit = profit2to1;
          bestArbitrage = {
            buyDex: dex2,
            sellDex: dex1,
            profitPercent: profit2to1,
            buyPrice: price2,
            sellPrice: price1
          };
        }
      }
    }
    
    return bestArbitrage;
  }

  calculateOptimalFlashLoanSize(arbitrage, impactAmount) {
    if (!this.config.dynamicSizing) {
      return parseFloat(process.env.ARBITRAGE_FLASH_LOAN_SIZE) || 100;
    }
    
    // Calculate based on liquidity and profit potential
    const baseSize = Math.min(
      parseFloat(ethers.utils.formatEther(impactAmount)) * 2, // 2x the impact trade
      this.config.maxFlashLoanAmount,
      arbitrage.profitPercent * 20 // Scale with profit potential
    );
    
    return Math.max(baseSize, 10); // Minimum 10 BNB
  }

  async executeFlashArbitrage(opportunity) {
    const arbitrageId = Date.now().toString();
    this.activeOpportunities.set(arbitrageId, opportunity);
    
    try {
      logger.info(`⚡ Executing flash arbitrage: ${opportunity.flashLoanSize} BNB loan for ${opportunity.profit.toFixed(4)} BNB profit`);
      
      if (!this.flashEngine) {
        logger.error('Flash Engine not deployed!');
        return false;
      }
      
      // Prepare flash loan parameters
      const flashLoanAmount = ethers.utils.parseEther(opportunity.flashLoanSize.toString());
      
      // Encode arbitrage data
      const arbitrageData = this.encodeArbitrageData(opportunity);
      
      // Execute flash loan
      const gasPrice = await this.bloxroute.estimateOptimalGasPrice('fast');
      
      const tx = await this.flashEngine.executeFlashArbitrage(
        this.config.venusVBNB, // vBNB address for flash loan
        flashLoanAmount,
        arbitrageData,
        {
          gasPrice,
          gasLimit: 800000
        }
      );
      
      logger.info(`📤 Flash arbitrage TX sent: ${tx.hash}`);
      
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        this.metrics.totalFlashLoans++;
        this.metrics.successfulFlashLoans++;
        this.metrics.totalProfit += opportunity.profit;
        this.metrics.largestProfit = Math.max(this.metrics.largestProfit, opportunity.profit);
        this.metrics.averageProfit = this.metrics.totalProfit / this.metrics.successfulFlashLoans;
        this.metrics.gasUsed += receipt.gasUsed.toNumber();
        
        logger.info(`✅ Flash arbitrage successful! Profit: ${opportunity.profit.toFixed(4)} BNB`);
        logger.info(`📊 Total flash loan profits: ${this.metrics.totalProfit.toFixed(4)} BNB`);
        
        return true;
      } else {
        logger.error('❌ Flash arbitrage transaction failed');
        return false;
      }
      
    } catch (error) {
      logger.error(`Flash arbitrage failed: ${error.message}`);
      this.metrics.totalFlashLoans++;
      return false;
    } finally {
      this.activeOpportunities.delete(arbitrageId);
    }
  }

  encodeArbitrageData(opportunity) {
    // Encode the arbitrage path and parameters
    return ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'address', 'uint256'],
      [
        opportunity.tokenA,
        opportunity.tokenB,
        this.dexes[opportunity.buyDex].router,
        this.dexes[opportunity.sellDex].router,
        ethers.utils.parseEther(opportunity.flashLoanSize.toString())
      ]
    );
  }

  isLargeSwap(tx) {
    // Check if transaction value or gas limit indicates a large swap
    const valueInBNB = parseFloat(ethers.utils.formatEther(tx.value || '0'));
    const gasLimit = parseInt(tx.gasLimit || '0');
    
    return valueInBNB > 10 || gasLimit > 200000; // Large trades
  }

  async decodeLargeSwap(tx) {
    // Simplified decoder - in production would use proper ABI decoding
    try {
      // This is a placeholder - implement proper swap decoding
      return {
        tokenA: process.env.WBNB_ADDRESS,
        tokenB: process.env.BUSD_ADDRESS,
        amountIn: tx.value || ethers.utils.parseEther('1')
      };
    } catch {
      return {};
    }
  }

  async getTokenPrice(routerAddress, tokenA, tokenB, amount) {
    try {
      const router = new ethers.Contract(
        routerAddress,
        ['function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)'],
        this.provider
      );
      
      const amounts = await router.getAmountsOut(amount, [tokenA, tokenB]);
      return parseFloat(ethers.utils.formatEther(amounts[1]));
    } catch {
      return null;
    }
  }

  async estimateGasCost() {
    const gasPrice = await this.provider.getGasPrice();
    const estimatedGas = 800000; // Flash loan gas estimate
    const gasCostWei = gasPrice.mul(estimatedGas);
    return parseFloat(ethers.utils.formatEther(gasCostWei));
  }

  startOpportunityScanning() {
    // Continuous scanning for arbitrage opportunities
    setInterval(async () => {
      await this.scanForStaticArbitrage();
    }, 5000); // Every 5 seconds
    
    // Report metrics
    setInterval(() => {
      this.reportMetrics();
    }, 60000); // Every minute
  }

  async scanForStaticArbitrage() {
    // Scan for existing arbitrage opportunities (not triggered by pending txs)
    const topTokenPairs = [
      [process.env.WBNB_ADDRESS, process.env.BUSD_ADDRESS],
      [process.env.WBNB_ADDRESS, process.env.USDT_ADDRESS],
      [process.env.WBNB_ADDRESS, process.env.CAKE_ADDRESS],
      [process.env.BUSD_ADDRESS, process.env.USDT_ADDRESS]
    ];
    
    for (const [tokenA, tokenB] of topTokenPairs) {
      const opportunity = await this.calculateFlashArbitrageOpportunity(tokenA, tokenB, ethers.utils.parseEther('0'));
      
      if (opportunity && opportunity.profit > this.config.minFlashLoanProfit) {
        logger.info(`🔍 Static arbitrage found: ${opportunity.profit.toFixed(4)} BNB profit`);
        await this.executeFlashArbitrage(opportunity);
      }
    }
  }

  async updatePriceCache() {
    // Update cached prices for faster calculations
    // Implementation would cache recent price data
  }

  reportMetrics() {
    logger.info('📊 FLASH LOAN ARBITRAGE METRICS:');
    logger.info(`⚡ Total Flash Loans: ${this.metrics.totalFlashLoans}`);
    logger.info(`✅ Successful: ${this.metrics.successfulFlashLoans}`);
    logger.info(`📈 Success Rate: ${(this.metrics.successfulFlashLoans / this.metrics.totalFlashLoans * 100).toFixed(1)}%`);
    logger.info(`💰 Total Profit: ${this.metrics.totalProfit.toFixed(4)} BNB`);
    logger.info(`🎯 Average Profit: ${this.metrics.averageProfit.toFixed(4)} BNB`);
    logger.info(`🚀 Largest Profit: ${this.metrics.largestProfit.toFixed(4)} BNB`);
    logger.info(`⛽ Total Gas Used: ${this.metrics.gasUsed.toLocaleString()}`);
  }

  getFlashEngineABI() {
    return [
      'function executeFlashArbitrage(address vToken, uint256 amount, bytes calldata data) external',
      'function owner() view returns (address)',
      'function emergencyWithdraw(address token) external'
    ];
  }

  async start() {
    try {
      await this.initialize();
      logger.info('🔥 Flash Loan Arbitrage Engine is running!');
      logger.info(`💰 Max flash loan: ${this.config.maxFlashLoanAmount} BNB`);
      logger.info(`📊 Min profit: ${this.config.minFlashLoanProfit} BNB`);
      logger.info(`⚡ Flash loan fee: ${(this.config.flashLoanFee * 100).toFixed(2)}%`);
      
      // Keep running
      process.stdin.resume();
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }
}

// Start the flash loan arbitrage engine
const engine = new FlashLoanArbitrageEngine();
engine.start();

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down Flash Loan Arbitrage Engine...');
  process.exit(0);
});