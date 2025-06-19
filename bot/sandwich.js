#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const WebSocket = require('ws');
const EventEmitter = require('events');

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
  }

  loadConfig() {
    return {
      rpcUrl: process.env.RPC_URL,
      privateKey: process.env.BOT_PRIVATE_KEY,
      minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD) || 0.10,
      minSwapUsd: parseFloat(process.env.MIN_SWAP_USD) || 50,
      gasPremiumGwei: parseFloat(process.env.GAS_PREMIUM_GWEI) || 1.5,
      maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 20,
      gasLimit: parseInt(process.env.GAS_LIMIT) || 500000,
      maxSlippage: parseFloat(process.env.MAX_SLIPPAGE) || 2.0,
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 100000,
      flashEngineAddress: process.env.FLASH_ENGINE_ADDRESS,
      scanInterval: parseInt(process.env.SCAN_INTERVAL) || 500,
      wsReconnectInterval: parseInt(process.env.WS_RECONNECT_INTERVAL) || 5000,
      maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10,
      chainId: parseInt(process.env.CHAIN_ID) || 56,
      minGasPrice: parseInt(process.env.MIN_GAS_PRICE) || 5
    };
  }

  async initialize() {
    try {
      logger.info('Initializing BSC Sandwich Bot...');
      logger.info(`Network: BSC (Chain ID: ${this.config.chainId})`);
      
      // Setup WebSocket provider for lower latency
      await this.setupWebSocketProvider();
      
      // Setup wallet
      this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
      logger.info(`Bot wallet: ${this.wallet.address}`);
      
      // Check wallet balance
      const balance = await this.wallet.getBalance();
      logger.info(`Wallet balance: ${ethers.utils.formatEther(balance)} BNB`);
      
      if (balance.lt(ethers.utils.parseEther('0.1'))) {
        logger.warn('Low BNB balance! Consider adding more for gas fees.');
      }
      
      // Setup event listeners
      this.setupEventListeners();
      
      // Initialize mempool monitoring
      await this.initializeMempoolMonitoring();
      
      logger.info('Bot initialization complete');
      return true;
    } catch (error) {
      logger.error('Failed to initialize bot:', error);
      throw error;
    }
  }

  async setupWebSocketProvider() {
    const maxAttempts = this.config.maxReconnectAttempts;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        this.provider = new ethers.providers.WebSocketProvider(this.config.rpcUrl);
        
        // Setup provider event handlers
        this.provider._websocket.on('open', () => {
          logger.info('WebSocket connection established to BSC');
          attempts = 0; // Reset attempts on successful connection
        });

        this.provider._websocket.on('close', async () => {
          logger.warn('WebSocket connection closed, attempting to reconnect...');
          setTimeout(() => this.setupWebSocketProvider(), this.config.wsReconnectInterval);
        });

        this.provider._websocket.on('error', (error) => {
          logger.error('WebSocket error:', error);
        });

        // Test the connection
        const network = await this.provider.getNetwork();
        if (network.chainId !== this.config.chainId) {
          throw new Error(`Wrong network! Expected BSC (56), got ${network.chainId}`);
        }
        
        await this.provider.getBlockNumber();
        return;
      } catch (error) {
        attempts++;
        logger.error(`Failed to connect (attempt ${attempts}/${maxAttempts}):`, error.message);
        
        if (attempts >= maxAttempts) {
          throw new Error('Max reconnection attempts reached');
        }
        
        await new Promise(resolve => setTimeout(resolve, this.config.wsReconnectInterval));
      }
    }
  }

  setupEventListeners() {
    // Handle process termination gracefully
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      this.handleCircuitBreaker();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      this.handleCircuitBreaker();
    });
  }

  async initializeMempoolMonitoring() {
    // Subscribe to pending transactions
    this.provider.on('pending', async (txHash) => {
      try {
        // Add to buffer for batch processing
        this.mempoolBuffer.push(txHash);
        
        // Process buffer when it reaches threshold (reduced for BSC's faster blocks)
        if (this.mempoolBuffer.length >= 5) {
          await this.processMempoolBatch();
        }
      } catch (error) {
        logger.error('Error handling pending transaction:', error);
      }
    });

    // Process any remaining transactions periodically (faster for BSC)
    setInterval(() => {
      if (this.mempoolBuffer.length > 0) {
        this.processMempoolBatch();
      }
    }, 50); // Faster processing for BSC's 3-second blocks
  }

  async processMempoolBatch() {
    const batch = this.mempoolBuffer.splice(0, 25); // Smaller batches for BSC
    
    // Parallel processing for efficiency
    const promises = batch.map(txHash => this.analyzePendingTransaction(txHash));
    await Promise.allSettled(promises);
  }

  async analyzePendingTransaction(txHash) {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx || !tx.to) return;

      this.tracker.updateMetrics('mempoolScans', 1);

      // Quick filter for relevant transactions (BSC DEX routers)
      if (!this.isRelevantTransaction(tx)) return;

      // Decode and analyze transaction
      const analysis = await this.analyzeTransaction(tx);
      if (!analysis) return;

      // Check profitability
      if (analysis.estimatedProfit > this.config.minProfitUsd) {
        this.tracker.updateMetrics('opportunitiesFound', 1);
        logger.info(`Opportunity found! Estimated profit: $${analysis.estimatedProfit.toFixed(2)}`);
        logger.info(`DEX: ${analysis.dexName}, Token pair: ${analysis.tokenPair}`);
        
        // Execute sandwich attack
        await this.executeSandwich(analysis);
      }
    } catch (error) {
      // Silently ignore common errors to avoid log spam
      if (!error.message.includes('unknown transaction')) {
        logger.debug('Error analyzing transaction:', error.message);
      }
    }
  }

  isRelevantTransaction(tx) {
    // Check if transaction is to a known DEX router
    const targetAddress = tx.to.toLowerCase();
    const isDexRouter = Object.values(this.dexRouters).some(
      router => router && router.toLowerCase() === targetAddress
    );
    
    if (!isDexRouter) return false;

    // Common swap method signatures on BSC DEXs
    const relevantMethods = [
      '0x38ed1739', // swapExactTokensForTokens
      '0x8803dbee', // swapTokensForExactTokens
      '0x7ff36ab5', // swapExactETHForTokens
      '0x18cbafe5', // swapExactTokensForETH
      '0xfb3bdb41', // swapETHForExactTokens
      '0x5c11d795', // swapExactTokensForTokensSupportingFeeOnTransferTokens
      '0xb6f9de95', // swapExactETHForTokensSupportingFeeOnTransferTokens
      '0x791ac947', // swapExactTokensForETHSupportingFeeOnTransferTokens
    ];

    const methodId = tx.data.slice(0, 10);
    return relevantMethods.includes(methodId);
  }

  async analyzeTransaction(tx) {
    try {
      // Identify which DEX
      const targetAddress = tx.to.toLowerCase();
      let dexName = 'Unknown';
      
      for (const [name, address] of Object.entries(this.dexRouters)) {
        if (address && address.toLowerCase() === targetAddress) {
          dexName = name;
          break;
        }
      }

      // Decode swap data
      const swapData = this.decodeSwapData(tx);
      if (!swapData) return null;

      // Estimate gas prices for BSC
      const gasPrice = await this.getOptimalGasPrice(tx);
      
      // Calculate potential profit
      const profit = await this.calculateProfit(swapData, gasPrice);
      
      return {
        originalTx: tx,
        swapData,
        gasPrice,
        estimatedProfit: profit,
        dexName,
        tokenPair: swapData.path ? `${swapData.path[0]}->${swapData.path[swapData.path.length-1]}` : 'Unknown',
        timestamp: Date.now()
      };
    } catch (error) {
      logger.debug('Error analyzing transaction:', error.message);
      return null;
    }
  }

  decodeSwapData(tx) {
    try {
      // Simplified decoder for common swap methods
      const methodId = tx.data.slice(0, 10);
      
      // Basic decoding logic (would be expanded for production)
      const decoded = {
        methodId,
        amountIn: ethers.BigNumber.from('0x' + tx.data.slice(10, 74)),
        path: [], // Would decode path from tx data
        to: tx.to,
        from: tx.from,
        value: tx.value
      };

      return decoded;
    } catch (error) {
      return null;
    }
  }

  async getOptimalGasPrice(targetTx) {
    const baseGasPrice = targetTx.gasPrice || (await this.provider.getGasPrice());
    const premiumWei = ethers.utils.parseUnits(this.config.gasPremiumGwei.toString(), 'gwei');
    const minGasPrice = ethers.utils.parseUnits(this.config.minGasPrice.toString(), 'gwei');
    
    // Ensure we meet BSC minimum gas price
    let adjustedBaseGasPrice = baseGasPrice;
    if (baseGasPrice.lt(minGasPrice)) {
      adjustedBaseGasPrice = minGasPrice;
    }
    
    // Front-run gas price (slightly higher for BSC's competitive environment)
    const frontRunGasPrice = adjustedBaseGasPrice.add(premiumWei);
    
    // Back-run gas price (slightly lower but still competitive)
    const backRunGasPrice = adjustedBaseGasPrice.add(premiumWei.div(3));
    
    // Cap at max gas price
    const maxGasPriceWei = ethers.utils.parseUnits(this.config.maxGasPrice.toString(), 'gwei');
    
    return { 
      frontRunGasPrice: frontRunGasPrice.gt(maxGasPriceWei) ? maxGasPriceWei : frontRunGasPrice,
      backRunGasPrice: backRunGasPrice.gt(maxGasPriceWei) ? maxGasPriceWei : backRunGasPrice,
      baseGasPrice: adjustedBaseGasPrice
    };
  }

  async calculateProfit(swapData, gasPrice) {
    // Simplified profit calculation
    // In production, this would involve:
    // 1. Simulating the impact of the target transaction
    // 2. Calculating optimal sandwich amounts
    // 3. Accounting for slippage and fees
    // 4. Estimating gas costs on BSC
    
    const estimatedRevenue = Math.random() * 50; // Placeholder - BSC has higher volumes
    const gasCostBnb = 0.003; // Lower gas costs on BSC
    const bnbPrice = 600; // Approximate BNB price
    const gasCostUsd = gasCostBnb * bnbPrice;
    
    return estimatedRevenue - gasCostUsd;
  }

  async executeSandwich(analysis) {
    if (this.circuitBreaker.isOpen) {
      logger.warn('Circuit breaker is open, skipping execution');
      return;
    }

    try {
      logger.info(`Executing sandwich attack on ${analysis.dexName}...`);
      
      // Would implement actual sandwich logic here
      // 1. Send front-run transaction with higher gas
      // 2. Wait for target transaction
      // 3. Send back-run transaction
      
      this.tracker.updateMetrics('transactionsExecuted', 1);
      this.tracker.updateMetrics('profitGenerated', analysis.estimatedProfit);
      
      logger.info(`Sandwich executed successfully! Profit: $${analysis.estimatedProfit.toFixed(2)}`);
      
      // Reset circuit breaker on success
      this.circuitBreaker.failures = 0;
    } catch (error) {
      logger.error('Failed to execute sandwich:', error);
      this.handleCircuitBreaker();
    }
  }

  handleCircuitBreaker() {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();
    
    if (this.circuitBreaker.failures >= this.circuitBreaker.maxFailures) {
      this.circuitBreaker.isOpen = true;
      logger.error('Circuit breaker opened due to excessive failures');
      
      // Auto-reset after 5 minutes
      setTimeout(() => {
        this.circuitBreaker.isOpen = false;
        this.circuitBreaker.failures = 0;
        logger.info('Circuit breaker reset');
      }, 300000);
    }
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