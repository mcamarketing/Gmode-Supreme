#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// Enhanced logger with performance monitoring
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: `logs/sandwich-${process.env.pm_id || '1'}-error.log`, level: 'error' }),
    new winston.transports.File({ filename: `logs/sandwich-${process.env.pm_id || '1'}-combined.log` }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Performance metrics tracker
class PerformanceTracker {
  constructor() {
    this.metrics = {
      mempoolScans: 0,
      opportunitiesFound: 0,
      transactionsExecuted: 0,
      profitGenerated: 0,
      gasUsed: 0,
      averageLatency: 0,
      startTime: Date.now()
    };
  }

  updateMetrics(type, value) {
    if (this.metrics[type] !== undefined) {
      this.metrics[type] += value;
    }
  }

  getMetrics() {
    const runtime = (Date.now() - this.metrics.startTime) / 1000 / 60; // minutes
    return {
      ...this.metrics,
      runtime,
      profitPerMinute: this.metrics.profitGenerated / runtime
    };
  }
}

// Optimized BSC MEV Sandwich Bot
class BSCSandwichBot extends EventEmitter {
  constructor() {
    super();
    this.config = this.loadConfig();
    this.provider = null;
    this.wallet = null;
    this.isRunning = false;
    this.pendingTxns = new Map();
    this.tracker = new PerformanceTracker();
    this.mempoolBuffer = [];
    this.processingQueue = [];
    this.wsConnection = null;
    
    // Circuit breaker for safety
    this.circuitBreaker = {
      failures: 0,
      maxFailures: parseInt(process.env.MAX_ANOMALIES) || 5,
      isOpen: false,
      lastFailure: null
    };
    
    // BSC-specific DEX routers
    this.dexRouters = {
      pancakeswap: process.env.PANCAKESWAP_ROUTER_V2,
      biswap: process.env.BISWAP_ROUTER,
      apeswap: process.env.APESWAP_ROUTER,
      bakeryswap: process.env.BAKERYSWAP_ROUTER
    };

    // Profit optimization
    this.pendingTransactions = new Map();
    this.executingTrades = new Set();
    this.priceCache = new Map();
    this.liquidityCache = new Map();
    
    // Performance optimizations
    this.txDecoder = null;
    this.routerInterfaces = new Map();
    this.pairContracts = new Map();
    
    this.isShuttingDown = false;
    this.setupLogger();
  }

  loadConfig() {
    return {
      // AGGRESSIVE SETTINGS FOR MAX PROFIT
      minSwapUsd: parseFloat(process.env.MIN_SWAP_USD) || 10, // Lower threshold
      minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD) || 0.02, // Very low
      gasPremiumGwei: parseFloat(process.env.GAS_PREMIUM_GWEI) || 2.5, // Higher for speed
      maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 30,
      minGasPrice: parseInt(process.env.MIN_GAS_PRICE) || 5,
      maxSlippage: parseFloat(process.env.MAX_SLIPPAGE) || 3.0,
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 10000,
      gasLimit: parseInt(process.env.GAS_LIMIT) || 600000,
      
      // Performance settings
      batchSize: 25, // Process in smaller batches for speed
      maxConcurrentTx: 5, // More concurrent transactions
      scanInterval: parseInt(process.env.SCAN_INTERVAL) || 250,
      cacheExpiry: 60000, // 1 minute cache
      
      // Multi-DEX support
      routers: {
        pancakeV2: process.env.PANCAKESWAP_ROUTER_V2,
        pancakeV3: process.env.PANCAKESWAP_ROUTER_V3,
        biswap: process.env.BISWAP_ROUTER,
        apeswap: process.env.APESWAP_ROUTER,
        bakery: process.env.BAKERYSWAP_ROUTER,
        mdex: process.env.MDEX_ROUTER,
        baby: process.env.BABYSWAP_ROUTER
      },
      
      // Circuit breaker
      maxAnomalies: parseInt(process.env.MAX_ANOMALIES) || 10,
      profitThreshold: parseFloat(process.env.PROFIT_THRESHOLD) || 0.01,
      
      // Network
      rpcUrl: process.env.RPC_URL,
      fallbackRpcs: process.env.FALLBACK_RPC_URLS?.split(',') || [],
      chainId: parseInt(process.env.CHAIN_ID) || 56,
      
      // Auto features
      autoExecute: process.env.AUTO_EXECUTE === 'true',
      autoWithdraw: process.env.AUTO_WITHDRAW_ENABLED === 'true',
      withdrawThreshold: parseFloat(process.env.AUTO_WITHDRAW_THRESHOLD) || 0.1
    };
  }

  async initialize() {
    this.logger.info('🚀 Initializing AGGRESSIVE Sandwich Bot...');
    
    try {
      // Setup multiple providers for redundancy
      await this.setupProviders();
      
      // Initialize wallet
      this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
      this.logger.info(`Bot wallet: ${this.wallet.address}`);
      
      // Check balance
      const balance = await this.wallet.getBalance();
      this.logger.info(`Balance: ${ethers.utils.formatEther(balance)} BNB`);
      
      if (balance.lt(ethers.utils.parseEther('0.05'))) {
        this.logger.warn('⚠️ Low balance! Need at least 0.05 BNB for gas');
      }
      
      // Setup router interfaces for all DEXs
      await this.setupRouterInterfaces();
      
      // Pre-cache top pairs
      await this.cacheToppairs();
      
      // Start WebSocket connection
      await this.connectWebSocket();
      
      // Start monitoring
      this.startAggresiveMonitoring();
      
      return true;
    } catch (error) {
      this.logger.error('Initialization failed:', error);
      throw error;
    }
  }

  async setupProviders() {
    // Primary WebSocket provider
    this.wsProvider = new ethers.providers.WebSocketProvider(this.config.rpcUrl);
    
    // Setup multiple HTTP providers for redundancy
    const providers = [this.wsProvider];
    
    for (const rpcUrl of this.config.fallbackRpcs) {
      providers.push(new ethers.providers.JsonRpcProvider(rpcUrl));
    }
    
    // Use the fastest provider
    this.provider = providers[0]; // For now, can implement race conditions later
    
    this.logger.info(`Connected to ${providers.length} RPC providers`);
  }

  setupRouterInterfaces() {
    // Pre-compile interfaces for speed
    const routerAbi = [
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
      'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
      'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
      'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
      'function getAmountsIn(uint amountOut, address[] calldata path) view returns (uint[] memory amounts)'
    ];
    
    const iface = new ethers.utils.Interface(routerAbi);
    
    for (const [name, address] of Object.entries(this.config.routers)) {
      if (address) {
        this.routerInterfaces.set(address.toLowerCase(), {
          name,
          interface: iface,
          contract: new ethers.Contract(address, routerAbi, this.wallet)
        });
      }
    }
  }

  async cacheToppairs() {
    // Pre-cache liquidity for top pairs
    const topPairs = [
      // Add top BSC pairs here
      { token0: process.env.WBNB_ADDRESS, token1: process.env.BUSD_ADDRESS },
      { token0: process.env.WBNB_ADDRESS, token1: process.env.USDT_ADDRESS },
      { token0: process.env.WBNB_ADDRESS, token1: process.env.CAKE_ADDRESS }
    ];
    
    for (const pair of topPairs) {
      // Cache liquidity data
      // Implementation depends on DEX
    }
  }

  startAggresiveMonitoring() {
    // Monitor pending transactions
    this.wsProvider.on('pending', async (txHash) => {
      if (this.pendingTransactions.size > 1000) {
        // Clear old transactions to prevent memory leak
        const oldTxs = Array.from(this.pendingTransactions.entries())
          .filter(([_, data]) => Date.now() - data.timestamp > 30000);
        
        oldTxs.forEach(([hash]) => this.pendingTransactions.delete(hash));
      }
      
      this.pendingTransactions.set(txHash, { timestamp: Date.now() });
      
      // Process in parallel
      this.processTransaction(txHash).catch(() => {
        // Ignore errors for speed
      });
    });
    
    // Process transactions in batches
    setInterval(() => {
      this.processPendingBatch();
    }, 50); // Every 50ms for speed
    
    // Profit monitoring
    setInterval(() => {
      this.reportProfits();
    }, 60000); // Every minute
    
    // Auto-withdraw check
    setInterval(() => {
      this.checkAutoWithdraw();
    }, 300000); // Every 5 minutes
  }

  async processTransaction(txHash) {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx || !tx.to || !tx.data || tx.data === '0x') return;
      
      // Quick check if it's a DEX transaction
      const routerInfo = this.routerInterfaces.get(tx.to.toLowerCase());
      if (!routerInfo) return;
      
      // Decode transaction
      const decoded = this.decodeTransaction(tx, routerInfo);
      if (!decoded) return;
      
      // Quick profitability check
      const opportunity = await this.analyzeOpportunity(tx, decoded, routerInfo);
      if (!opportunity) return;
      
      // Execute if profitable
      if (opportunity.expectedProfit > this.config.minProfitUsd) {
        this.executeOpportunity(opportunity);
      }
      
    } catch (error) {
      // Ignore errors for speed
    }
  }

  decodeTransaction(tx, routerInfo) {
    try {
      const decoded = routerInfo.interface.parseTransaction(tx);
      
      // Handle different swap methods
      if (decoded.name === 'swapExactETHForTokens' || 
          decoded.name === 'swapExactTokensForETH' ||
          decoded.name === 'swapExactTokensForTokens') {
        
        return {
          method: decoded.name,
          amountIn: decoded.args.amountIn || tx.value,
          amountOutMin: decoded.args.amountOutMin,
          path: decoded.args.path,
          to: decoded.args.to,
          deadline: decoded.args.deadline,
          value: tx.value
        };
      }
      
      return null;
    } catch {
      return null;
    }
  }

  async analyzeOpportunity(victimTx, decoded, routerInfo) {
    // Quick profitability analysis
    const path = decoded.path;
    const amountIn = decoded.amountIn;
    
    // Skip small trades
    const valueInBnb = decoded.method === 'swapExactETHForTokens' 
      ? ethers.utils.formatEther(amountIn)
      : await this.estimateValueInBnb(path[0], amountIn);
    
    if (parseFloat(valueInBnb) * 300 < this.config.minSwapUsd) {
      return null; // Too small
    }
    
    // Calculate sandwich profit
    const sandwichProfit = await this.calculateSandwichProfit(
      path,
      amountIn,
      routerInfo,
      victimTx.gasPrice
    );
    
    if (sandwichProfit.profit <= 0) return null;
    
    return {
      type: 'sandwich',
      victimTx,
      decoded,
      router: routerInfo,
      path,
      amountIn,
      expectedProfit: sandwichProfit.profit,
      frontrunAmount: sandwichProfit.optimalAmount,
      gasPrice: sandwichProfit.gasPrice
    };
  }

  async calculateSandwichProfit(path, victimAmount, routerInfo, victimGasPrice) {
    try {
      // Get current reserves
      const reserves = await this.getReserves(path[0], path[1]);
      if (!reserves) return { profit: 0 };
      
      // Calculate impact of victim's trade
      const victimImpact = this.calculatePriceImpact(
        victimAmount,
        reserves.reserve0,
        reserves.reserve1
      );
      
      // Calculate optimal sandwich amount (aggressive)
      const optimalAmount = victimAmount.div(2); // 50% of victim's trade
      
      // Calculate expected profit
      const frontrunImpact = this.calculatePriceImpact(
        optimalAmount,
        reserves.reserve0,
        reserves.reserve1
      );
      
      // Estimate profit in USD
      const profitRatio = (victimImpact + frontrunImpact) * 0.997; // Account for fees
      const profitInBnb = parseFloat(ethers.utils.formatEther(optimalAmount)) * profitRatio;
      const profitInUsd = profitInBnb * 300; // Assume BNB = $300
      
      // Calculate gas costs
      const gasPrice = victimGasPrice.mul(100 + this.config.gasPremiumGwei * 10).div(100);
      const gasCost = gasPrice.mul(this.config.gasLimit).mul(2); // Two transactions
      const gasCostUsd = parseFloat(ethers.utils.formatEther(gasCost)) * 300;
      
      return {
        profit: profitInUsd - gasCostUsd,
        optimalAmount,
        gasPrice
      };
      
    } catch {
      return { profit: 0 };
    }
  }

  async executeOpportunity(opportunity) {
    if (this.executingTrades.size >= this.config.maxConcurrentTx) {
      return; // Too many concurrent trades
    }
    
    const tradeId = Date.now().toString();
    this.executingTrades.add(tradeId);
    
    try {
      this.logger.info(`🎯 Executing sandwich: Expected profit $${opportunity.expectedProfit.toFixed(2)}`);
      
      // Prepare frontrun transaction
      const frontrunTx = await this.prepareFrontrunTx(opportunity);
      
      // Send frontrun
      const frontrunReceipt = await this.wallet.sendTransaction(frontrunTx);
      this.logger.info(`📤 Frontrun sent: ${frontrunReceipt.hash}`);
      
      // Wait for victim transaction
      await this.waitForTransaction(opportunity.victimTx.hash);
      
      // Send backrun
      const backrunTx = await this.prepareBackrunTx(opportunity, frontrunReceipt.hash);
      const backrunReceipt = await this.wallet.sendTransaction(backrunTx);
      this.logger.info(`📤 Backrun sent: ${backrunReceipt.hash}`);
      
      // Wait for completion
      await backrunReceipt.wait();
      
      // Update metrics
      this.metrics.totalTrades++;
      this.metrics.profitableTrades++;
      this.metrics.totalProfit += opportunity.expectedProfit;
      
      this.logger.info(`✅ Sandwich completed! Profit: $${opportunity.expectedProfit.toFixed(2)}`);
      
    } catch (error) {
      this.logger.error('Sandwich execution failed:', error.message);
      this.metrics.anomalies++;
    } finally {
      this.executingTrades.delete(tradeId);
    }
  }

  async prepareFrontrunTx(opportunity) {
    const { router, path, frontrunAmount, gasPrice } = opportunity;
    
    if (path[0] === process.env.WBNB_ADDRESS) {
      // Buy tokens with BNB
      return {
        to: router.contract.address,
        data: router.interface.encodeFunctionData('swapExactETHForTokens', [
          0, // Accept any amount
          path,
          this.wallet.address,
          Math.floor(Date.now() / 1000) + 300
        ]),
        value: frontrunAmount,
        gasPrice,
        gasLimit: this.config.gasLimit
      };
    } else {
      // Token to token swap
      // Need to approve first
      const tokenContract = new ethers.Contract(
        path[0],
        ['function approve(address spender, uint256 amount)'],
        this.wallet
      );
      
      await tokenContract.approve(router.contract.address, frontrunAmount);
      
      return {
        to: router.contract.address,
        data: router.interface.encodeFunctionData('swapExactTokensForTokens', [
          frontrunAmount,
          0,
          path,
          this.wallet.address,
          Math.floor(Date.now() / 1000) + 300
        ]),
        gasPrice,
        gasLimit: this.config.gasLimit
      };
    }
  }

  async prepareBackrunTx(opportunity, frontrunTxHash) {
    // Prepare the sell transaction
    const { router, path } = opportunity;
    const reversePath = [...path].reverse();
    
    // Get our token balance
    const tokenContract = new ethers.Contract(
      path[path.length - 1],
      ['function balanceOf(address) view returns (uint256)'],
      this.provider
    );
    
    const balance = await tokenContract.balanceOf(this.wallet.address);
    
    return {
      to: router.contract.address,
      data: router.interface.encodeFunctionData('swapExactTokensForETH', [
        balance,
        0,
        reversePath,
        this.wallet.address,
        Math.floor(Date.now() / 1000) + 300
      ]),
      gasPrice: opportunity.gasPrice,
      gasLimit: this.config.gasLimit
    };
  }

  async checkAutoWithdraw() {
    if (!this.config.autoWithdraw) return;
    
    const balance = await this.wallet.getBalance();
    const threshold = ethers.utils.parseEther(this.config.withdrawThreshold.toString());
    
    if (balance.gt(threshold)) {
      const withdrawAmount = balance.mul(80).div(100); // Keep 20% for gas
      
      this.logger.info(`💸 Auto-withdrawing ${ethers.utils.formatEther(withdrawAmount)} BNB`);
      
      try {
        const tx = await this.wallet.sendTransaction({
          to: process.env.COLD_WALLET_ADDRESS,
          value: withdrawAmount,
          gasPrice: await this.provider.getGasPrice()
        });
        
        await tx.wait();
        this.logger.info(`✅ Withdrawn to cold wallet: ${tx.hash}`);
      } catch (error) {
        this.logger.error('Auto-withdraw failed:', error);
      }
    }
  }

  reportProfits() {
    const runtime = (Date.now() - this.metrics.startTime) / 1000 / 60 / 60; // hours
    const profitPerHour = this.metrics.totalProfit / runtime;
    
    this.logger.info('📊 PROFIT REPORT:');
    this.logger.info(`Total Trades: ${this.metrics.totalTrades}`);
    this.logger.info(`Profitable: ${this.metrics.profitableTrades}`);
    this.logger.info(`Total Profit: $${this.metrics.totalProfit.toFixed(2)}`);
    this.logger.info(`Profit/Hour: $${profitPerHour.toFixed(2)}`);
    this.logger.info(`Success Rate: ${(this.metrics.profitableTrades / this.metrics.totalTrades * 100).toFixed(1)}%`);
  }

  calculatePriceImpact(amountIn, reserve0, reserve1) {
    // Simplified price impact calculation
    const amountInWithFee = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserve1);
    const denominator = reserve0.mul(1000).add(amountInWithFee);
    const amountOut = numerator.div(denominator);
    
    const priceBefor = reserve1.div(reserve0);
    const newReserve0 = reserve0.add(amountIn);
    const newReserve1 = reserve1.sub(amountOut);
    const priceAfter = newReserve1.div(newReserve0);
    
    return priceAfter.sub(priceBefor).div(priceBefor).toNumber();
  }

  async start() {
    try {
      await this.initialize();
      this.isRunning = true;
      logger.info('BSC Sandwich bot started successfully');
      logger.info(`Monitoring DEXs: ${Object.keys(this.dexRouters).join(', ')}`);
      
      // Log metrics periodically
      setInterval(() => {
        const metrics = this.tracker.getMetrics();
        logger.info('Performance metrics:', metrics);
      }, 60000);
      
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  async shutdown() {
    logger.info('Shutting down bot...');
    this.isRunning = false;
    
    if (this.provider && this.provider._websocket) {
      this.provider._websocket.terminate();
    }
    
    const metrics = this.tracker.getMetrics();
    logger.info('Final metrics:', metrics);
    
    process.exit(0);
  }
}

// Start the bot
const bot = new BSCSandwichBot();
bot.start().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});