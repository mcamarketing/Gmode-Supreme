#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const EventEmitter = require('events');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/profit-hunter-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/profit-hunter-combined.log' }),
    new winston.transports.Console()
  ]
});

// Profit tracking
class ProfitTracker {
  constructor() {
    this.totalProfit = 0;
    this.dailyProfit = 0;
    this.hourlyProfit = 0;
    this.profitsByStrategy = {};
    this.startTime = Date.now();
    this.lastHourReset = Date.now();
    this.lastDayReset = Date.now();
  }

  addProfit(amount, strategy) {
    this.totalProfit += amount;
    this.dailyProfit += amount;
    this.hourlyProfit += amount;
    
    if (!this.profitsByStrategy[strategy]) {
      this.profitsByStrategy[strategy] = 0;
    }
    this.profitsByStrategy[strategy] += amount;
    
    // Reset hourly/daily counters
    const now = Date.now();
    if (now - this.lastHourReset > 3600000) {
      this.hourlyProfit = 0;
      this.lastHourReset = now;
    }
    if (now - this.lastDayReset > 86400000) {
      this.dailyProfit = 0;
      this.lastDayReset = now;
    }
    
    logger.info(`💰 PROFIT: $${amount.toFixed(2)} from ${strategy}`);
    logger.info(`📊 Total: $${this.totalProfit.toFixed(2)} | Daily: $${this.dailyProfit.toFixed(2)} | Hourly: $${this.hourlyProfit.toFixed(2)}`);
  }

  getStats() {
    const runtime = (Date.now() - this.startTime) / 1000 / 60 / 60; // hours
    return {
      totalProfit: this.totalProfit,
      dailyProfit: this.dailyProfit,
      hourlyProfit: this.hourlyProfit,
      profitPerHour: this.totalProfit / runtime,
      profitsByStrategy: this.profitsByStrategy,
      runtime
    };
  }
}

class AggressiveProfitHunter extends EventEmitter {
  constructor() {
    super();
    this.config = this.loadConfig();
    this.providers = [];
    this.wallet = null;
    this.profitTracker = new ProfitTracker();
    this.pendingTxs = new Map();
    this.executingTrades = new Set();
    this.knownTokens = new Map();
    this.priceCache = new Map();
    
    // Strategy flags
    this.strategies = {
      sandwich: process.env.ENABLE_SANDWICH === 'true',
      arbitrage: process.env.ENABLE_ARBITRAGE === 'true',
      liquidations: process.env.ENABLE_LIQUIDATIONS === 'true',
      newPairs: process.env.ENABLE_NEW_PAIRS === 'true',
      frontrun: process.env.ENABLE_FRONTRUN === 'true',
      backrun: process.env.ENABLE_BACKRUN === 'true'
    };
    
    // DEX routers
    this.routers = {
      pancakeV2: process.env.PANCAKESWAP_ROUTER_V2,
      pancakeV3: process.env.PANCAKESWAP_ROUTER_V3,
      biswap: process.env.BISWAP_ROUTER,
      apeswap: process.env.APESWAP_ROUTER,
      bakery: process.env.BAKERYSWAP_ROUTER,
      mdex: process.env.MDEX_ROUTER,
      baby: process.env.BABYSWAP_ROUTER
    };
  }

  loadConfig() {
    return {
      minSwapUsd: parseFloat(process.env.MIN_SWAP_USD) || 10,
      minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD) || 0.02,
      gasPremiumGwei: parseFloat(process.env.GAS_PREMIUM_GWEI) || 2.5,
      maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 30,
      maxConcurrentTrades: parseInt(process.env.MAX_CONCURRENT_TRADES) || 5,
      scanInterval: parseInt(process.env.SCAN_INTERVAL) || 250,
      autoExecute: process.env.AUTO_EXECUTE === 'true',
      riskLevel: process.env.RISK_LEVEL || 'aggressive'
    };
  }

  async initialize() {
    logger.info('🚀 Initializing Aggressive Profit Hunter...');
    logger.info(`💎 Strategies enabled: ${Object.entries(this.strategies).filter(([k,v]) => v).map(([k]) => k).join(', ')}`);
    
    // Setup multiple RPC providers for redundancy
    await this.setupProviders();
    
    // Setup wallet
    this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.providers[0]);
    logger.info(`🔑 Bot wallet: ${this.wallet.address}`);
    
    // Check balance
    const balance = await this.wallet.getBalance();
    logger.info(`💰 Balance: ${ethers.utils.formatEther(balance)} BNB`);
    
    if (balance.lt(ethers.utils.parseEther('0.05'))) {
      logger.warn('⚠️ Low BNB balance! Add funds for gas fees.');
    }
    
    // Start all profit strategies
    this.startAllStrategies();
    
    return true;
  }

  async setupProviders() {
    // Primary WebSocket provider
    const primary = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
    this.providers.push(primary);
    
    // Setup fallback HTTP providers
    const fallbackUrls = process.env.FALLBACK_RPC_URLS.split(',');
    for (const url of fallbackUrls) {
      this.providers.push(new ethers.providers.JsonRpcProvider(url));
    }
    
    logger.info(`✅ Connected to ${this.providers.length} RPC providers`);
  }

  startAllStrategies() {
    // 1. Mempool scanning for all strategies
    if (this.strategies.sandwich || this.strategies.frontrun || this.strategies.backrun) {
      this.startMempoolScanning();
    }
    
    // 2. Arbitrage scanning across all DEXs
    if (this.strategies.arbitrage) {
      this.startArbitrageScanning();
    }
    
    // 3. New pair sniping
    if (this.strategies.newPairs) {
      this.startNewPairSniping();
    }
    
    // 4. Liquidation monitoring
    if (this.strategies.liquidations) {
      this.startLiquidationMonitoring();
    }
    
    // 5. Price monitoring for all tokens
    this.startPriceMonitoring();
    
    // 6. Profit reporting
    setInterval(() => {
      const stats = this.profitTracker.getStats();
      logger.info('📈 PROFIT REPORT:', stats);
    }, 60000); // Every minute
  }

  async startMempoolScanning() {
    logger.info('👁️ Starting aggressive mempool scanning...');
    
    this.providers[0].on('pending', async (txHash) => {
      try {
        const tx = await this.providers[0].getTransaction(txHash);
        if (!tx || !tx.to) return;
        
        // Quick profitability check
        const opportunity = await this.analyzePendingTx(tx);
        if (opportunity && opportunity.profit > this.config.minProfitUsd) {
          await this.executeOpportunity(opportunity);
        }
      } catch (error) {
        // Ignore errors for speed
      }
    });
  }

  async analyzePendingTx(tx) {
    // Check if it's a DEX transaction
    const targetRouter = Object.entries(this.routers).find(([name, address]) => 
      address && tx.to.toLowerCase() === address.toLowerCase()
    );
    
    if (!targetRouter) return null;
    
    const [dexName, routerAddress] = targetRouter;
    
    // Decode transaction
    const decoded = await this.decodeSwapTx(tx);
    if (!decoded) return null;
    
    // Calculate potential profits for different strategies
    const opportunities = [];
    
    if (this.strategies.sandwich) {
      const sandwichProfit = await this.calculateSandwichProfit(tx, decoded, dexName);
      if (sandwichProfit > 0) {
        opportunities.push({
          type: 'sandwich',
          profit: sandwichProfit,
          tx,
          decoded,
          dex: dexName
        });
      }
    }
    
    if (this.strategies.frontrun) {
      const frontrunProfit = await this.calculateFrontrunProfit(tx, decoded, dexName);
      if (frontrunProfit > 0) {
        opportunities.push({
          type: 'frontrun',
          profit: frontrunProfit,
          tx,
          decoded,
          dex: dexName
        });
      }
    }
    
    // Return most profitable opportunity
    return opportunities.sort((a, b) => b.profit - a.profit)[0];
  }

  async startArbitrageScanning() {
    logger.info('🔄 Starting multi-DEX arbitrage scanning...');
    
    const scanArbitrage = async () => {
      try {
        // Get top traded tokens
        const tokens = await this.getTopTokens();
        
        for (const token of tokens) {
          const prices = await this.getPricesAcrossDexs(token);
          const arbitrage = this.findArbitrageOpportunity(prices, token);
          
          if (arbitrage && arbitrage.profit > this.config.minProfitUsd) {
            await this.executeArbitrage(arbitrage);
          }
        }
      } catch (error) {
        logger.error('Arbitrage scan error:', error);
      }
    };
    
    // Run continuously
    setInterval(scanArbitrage, this.config.scanInterval);
    scanArbitrage(); // Run immediately
  }

  async startNewPairSniping() {
    logger.info('🎯 Starting new pair sniping...');
    
    // Monitor PancakeSwap factory for new pairs
    const factoryAbi = [
      'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
    ];
    
    const factory = new ethers.Contract(
      process.env.PANCAKESWAP_FACTORY_V2,
      factoryAbi,
      this.providers[0]
    );
    
    factory.on('PairCreated', async (token0, token1, pair, index) => {
      logger.info(`🆕 NEW PAIR DETECTED: ${token0} / ${token1}`);
      
      // Quick safety checks
      const isSafe = await this.checkTokenSafety(token0, token1);
      if (!isSafe) {
        logger.warn('⚠️ Unsafe token detected, skipping');
        return;
      }
      
      // Try to snipe with small amount
      const snipeAmount = ethers.utils.parseEther('0.05'); // 0.05 BNB
      await this.snipeNewPair(pair, token0, token1, snipeAmount);
    });
  }

  async startLiquidationMonitoring() {
    logger.info('🏦 Starting liquidation monitoring...');
    
    const checkLiquidations = async () => {
      try {
        // Check Venus Protocol
        const venusPositions = await this.getVenusLiquidatablePositions();
        for (const position of venusPositions) {
          if (position.profitableToLiquidate) {
            await this.executeLiquidation(position, 'venus');
          }
        }
        
        // Check Alpaca Finance
        const alpacaPositions = await this.getAlpacaLiquidatablePositions();
        for (const position of alpacaPositions) {
          if (position.profitableToLiquidate) {
            await this.executeLiquidation(position, 'alpaca');
          }
        }
      } catch (error) {
        logger.error('Liquidation check error:', error);
      }
    };
    
    setInterval(checkLiquidations, 5000); // Every 5 seconds
    checkLiquidations();
  }

  async executeOpportunity(opportunity) {
    if (this.executingTrades.size >= this.config.maxConcurrentTrades) {
      return; // Skip if too many concurrent trades
    }
    
    const tradeId = Date.now().toString();
    this.executingTrades.add(tradeId);
    
    try {
      logger.info(`🎯 Executing ${opportunity.type} opportunity: $${opportunity.profit.toFixed(2)} profit`);
      
      let success = false;
      
      switch (opportunity.type) {
        case 'sandwich':
          success = await this.executeSandwich(opportunity);
          break;
        case 'frontrun':
          success = await this.executeFrontrun(opportunity);
          break;
        case 'arbitrage':
          success = await this.executeArbitrage(opportunity);
          break;
      }
      
      if (success) {
        this.profitTracker.addProfit(opportunity.profit, opportunity.type);
        
        // Auto-withdraw if threshold reached
        await this.checkAutoWithdraw();
      }
    } catch (error) {
      logger.error(`Failed to execute ${opportunity.type}:`, error);
    } finally {
      this.executingTrades.delete(tradeId);
    }
  }

  async executeSandwich(opportunity) {
    const { tx, decoded, dex } = opportunity;
    
    // Calculate optimal sandwich amounts
    const sandwichAmount = this.calculateOptimalSandwichAmount(decoded);
    
    // Prepare transactions
    const frontTx = await this.prepareFrontrunTx(decoded, sandwichAmount, tx.gasPrice);
    const backTx = await this.prepareBackrunTx(decoded, sandwichAmount, tx.gasPrice);
    
    // Send transactions
    const frontReceipt = await this.wallet.sendTransaction(frontTx);
    logger.info(`📤 Front tx sent: ${frontReceipt.hash}`);
    
    // Wait for target tx
    await this.waitForTx(tx.hash);
    
    const backReceipt = await this.wallet.sendTransaction(backTx);
    logger.info(`📤 Back tx sent: ${backReceipt.hash}`);
    
    // Wait for completion
    await backReceipt.wait();
    
    return true;
  }

  async executeArbitrage(opportunity) {
    const { path, profit, dexPath } = opportunity;
    
    logger.info(`💱 Executing arbitrage: ${dexPath.join(' -> ')}`);
    
    // Use flash loan if needed
    if (opportunity.requiresFlashLoan) {
      return await this.executeFlashLoanArbitrage(opportunity);
    }
    
    // Direct arbitrage with own funds
    const amount = ethers.utils.parseEther('0.1'); // Start with 0.1 BNB
    
    for (let i = 0; i < path.length; i++) {
      const dex = dexPath[i];
      const router = this.routers[dex];
      
      // Execute swap on each DEX
      await this.executeSwap(router, path[i], amount);
    }
    
    return true;
  }

  async getTopTokens() {
    // Return most traded tokens on BSC
    return [
      process.env.WBNB_ADDRESS,
      process.env.BUSD_ADDRESS,
      process.env.USDT_ADDRESS,
      process.env.USDC_ADDRESS,
      process.env.CAKE_ADDRESS,
      process.env.ETH_ADDRESS,
      process.env.BTCB_ADDRESS
    ];
  }

  async getPricesAcrossDexs(token) {
    const prices = {};
    const amount = ethers.utils.parseEther('1');
    
    for (const [dexName, routerAddress] of Object.entries(this.routers)) {
      try {
        const price = await this.getTokenPrice(routerAddress, token, amount);
        prices[dexName] = price;
      } catch (error) {
        // Skip if DEX doesn't have the pair
      }
    }
    
    return prices;
  }

  findArbitrageOpportunity(prices, token) {
    const priceArray = Object.entries(prices);
    if (priceArray.length < 2) return null;
    
    // Sort by price
    priceArray.sort((a, b) => a[1] - b[1]);
    
    const [buyDex, buyPrice] = priceArray[0];
    const [sellDex, sellPrice] = priceArray[priceArray.length - 1];
    
    const profitPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
    
    // Account for fees and slippage
    const netProfitPercent = profitPercent - 0.6; // 0.3% fee each way
    
    if (netProfitPercent > 0.1) { // 0.1% minimum profit
      const profitUsd = (netProfitPercent / 100) * buyPrice * 100; // Assume $100 trade
      
      return {
        token,
        buyDex,
        sellDex,
        buyPrice,
        sellPrice,
        profitPercent: netProfitPercent,
        profit: profitUsd,
        path: [[token, process.env.WBNB_ADDRESS], [process.env.WBNB_ADDRESS, token]],
        dexPath: [buyDex, sellDex]
      };
    }
    
    return null;
  }

  async checkAutoWithdraw() {
    const balance = await this.wallet.getBalance();
    const threshold = ethers.utils.parseEther(process.env.AUTO_WITHDRAW_THRESHOLD || '0.1');
    
    if (balance.gt(threshold) && process.env.AUTO_WITHDRAW_ENABLED === 'true') {
      const withdrawAmount = balance.mul(80).div(100); // Withdraw 80%
      
      logger.info(`💸 Auto-withdrawing ${ethers.utils.formatEther(withdrawAmount)} BNB`);
      
      const tx = await this.wallet.sendTransaction({
        to: process.env.COLD_WALLET_ADDRESS,
        value: withdrawAmount
      });
      
      await tx.wait();
      logger.info(`✅ Withdrawn to cold wallet: ${tx.hash}`);
    }
  }

  async checkTokenSafety(token0, token1) {
    // Basic safety checks for new tokens
    try {
      const tokenContract = new ethers.Contract(
        token0 === process.env.WBNB_ADDRESS ? token1 : token0,
        ['function name() view returns (string)', 'function symbol() view returns (string)'],
        this.providers[0]
      );
      
      // Try to call basic functions
      await tokenContract.name();
      await tokenContract.symbol();
      
      return true;
    } catch {
      return false;
    }
  }

  calculateOptimalSandwichAmount(decoded) {
    // Calculate based on victim's trade size
    const victimAmount = decoded.amountIn;
    
    // Use 50% of victim's amount for aggressive strategy
    return victimAmount.div(2);
  }

  async startPriceMonitoring() {
    // Monitor prices for volatility-based opportunities
    setInterval(async () => {
      const tokens = await this.getTopTokens();
      for (const token of tokens) {
        const currentPrice = await this.getTokenPrice(this.routers.pancakeV2, token, ethers.utils.parseEther('1'));
        const cachedPrice = this.priceCache.get(token);
        
        if (cachedPrice) {
          const priceChange = Math.abs((currentPrice - cachedPrice) / cachedPrice * 100);
          if (priceChange > 5) { // 5% price change
            logger.info(`📊 Large price movement detected for ${token}: ${priceChange.toFixed(2)}%`);
            // Could trigger rebalancing or other strategies
          }
        }
        
        this.priceCache.set(token, currentPrice);
      }
    }, 10000); // Every 10 seconds
  }

  async start() {
    try {
      await this.initialize();
      logger.info('🟢 Aggressive Profit Hunter is running!');
      logger.info(`⚡ Risk level: ${this.config.riskLevel}`);
      logger.info(`💰 Min profit threshold: $${this.config.minProfitUsd}`);
      logger.info(`🔥 Auto-execute: ${this.config.autoExecute}`);
      
      // Keep running
      process.stdin.resume();
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }

  shutdown() {
    logger.info('Shutting down Profit Hunter...');
    const stats = this.profitTracker.getStats();
    logger.info('Final profit report:', stats);
    process.exit(0);
  }
}

// Start the aggressive profit hunter
const hunter = new AggressiveProfitHunter();
hunter.start();

// Graceful shutdown
process.on('SIGINT', () => hunter.shutdown());
process.on('SIGTERM', () => hunter.shutdown());