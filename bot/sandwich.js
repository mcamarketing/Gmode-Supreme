const { ethers } = require('ethers');
const { logger } = require('./lib/logger');
const { MempoolMonitor } = require('./lib/mempoolMonitor');
const { SandwichAnalyzer } = require('./lib/sandwichAnalyzer');
const { TransactionExecutor } = require('./lib/transactionExecutor');
const { ProfitTracker } = require('./lib/profitTracker');
const { CircuitBreaker } = require('./lib/circuitBreaker');

class SandwichBot {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.mempoolMonitor = null;
    this.analyzer = null;
    this.executor = null;
    this.profitTracker = null;
    this.circuitBreaker = null;
    this.isRunning = false;
    
    // Configuration
    this.config = {
      minSwapUSD: parseFloat(process.env.MIN_SWAP_USD) || 25,
      minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.05,
      gasPremiumGwei: parseFloat(process.env.GAS_PREMIUM_GWEI) || 2.0,
      maxGasPrice: ethers.parseUnits(process.env.MAX_GAS_PRICE || '1000', 'gwei'),
      scanInterval: parseInt(process.env.SCAN_INTERVAL) || 1000,
      flashEngineAddress: process.env.FLASH_ENGINE_ADDRESS
    };
  }

  async initialize() {
    try {
      logger.info('Initializing Sandwich Bot...');
      
      // Validate environment
      this.validateEnvironment();
      
      // Initialize provider
      const rpcUrl = process.env.RPC_URL;
      if (!rpcUrl.startsWith('ws')) {
        throw new Error('WebSocket RPC URL required for mempool monitoring');
      }
      
      this.provider = new ethers.WebSocketProvider(rpcUrl);
      
      // Initialize wallet
      this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
      logger.info(`Bot wallet: ${this.wallet.address}`);
      
      // Check balance
      const balance = await this.provider.getBalance(this.wallet.address);
      logger.info(`Wallet balance: ${ethers.formatEther(balance)} MATIC`);
      
      if (balance.lt(ethers.parseEther('0.1'))) {
        logger.warn('Low wallet balance. Consider adding more MATIC for gas fees.');
      }
      
      // Initialize components
      this.mempoolMonitor = new MempoolMonitor(this.provider);
      this.analyzer = new SandwichAnalyzer(this.provider);
      this.executor = new TransactionExecutor(this.wallet, this.config.flashEngineAddress);
      this.profitTracker = new ProfitTracker();
      this.circuitBreaker = new CircuitBreaker({
        maxAnomalies: parseInt(process.env.MAX_ANOMALIES) || 5,
        profitThreshold: parseFloat(process.env.PROFIT_THRESHOLD) || 0.05
      });
      
      // Set up event handlers
      this.setupEventHandlers();
      
      logger.info('Sandwich Bot initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize bot:', error);
      throw error;
    }
  }

  validateEnvironment() {
    const required = [
      'RPC_URL',
      'BOT_PRIVATE_KEY',
      'FLASH_ENGINE_ADDRESS',
      'PLATFORM_WALLET'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  setupEventHandlers() {
    // Mempool monitor events
    this.mempoolMonitor.on('transaction', async (tx) => {
      try {
        await this.handleTransaction(tx);
      } catch (error) {
        logger.error('Error handling transaction:', error);
      }
    });
    
    // Profit tracker events
    this.profitTracker.on('profit', (data) => {
      logger.info(`💰 Profit recorded: ${data.profitUSD} USD`);
    });
    
    // Circuit breaker events
    this.circuitBreaker.on('triggered', () => {
      logger.warn('⚠️ Circuit breaker triggered! Pausing bot...');
      this.pause();
    });
  }

  async handleTransaction(tx) {
    // Quick filters
    if (!this.shouldAnalyze(tx)) return;
    
    // Analyze for sandwich opportunity
    const opportunity = await this.analyzer.analyze(tx);
    
    if (!opportunity) return;
    
    // Check if profitable
    if (opportunity.expectedProfitUSD < this.config.minProfitUSD) {
      logger.debug(`Opportunity below profit threshold: ${opportunity.expectedProfitUSD} USD`);
      return;
    }
    
    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      logger.warn('Circuit breaker preventing execution');
      return;
    }
    
    logger.info(`🎯 Sandwich opportunity found:`, {
      targetTx: tx.hash,
      expectedProfit: opportunity.expectedProfitUSD,
      token: opportunity.token,
      amount: opportunity.amount
    });
    
    // Execute sandwich
    await this.executeSandwich(opportunity);
  }

  shouldAnalyze(tx) {
    // Basic filters
    if (!tx.to || !tx.data || tx.data === '0x') return false;
    
    // Check if it's a DEX transaction
    const knownDEXs = [
      '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // QuickSwap
      '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap
      '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'  // Uniswap V3
    ];
    
    if (!knownDEXs.includes(tx.to.toLowerCase())) return false;
    
    // Check transaction value
    const valueInEth = parseFloat(ethers.formatEther(tx.value || '0'));
    const valueInUSD = valueInEth * 2; // Rough estimate (MATIC ~$2)
    
    return valueInUSD >= this.config.minSwapUSD;
  }

  async executeSandwich(opportunity) {
    const startTime = Date.now();
    
    try {
      // Execute sandwich attack
      const result = await this.executor.executeSandwich(opportunity);
      
      if (result.success) {
        const executionTime = Date.now() - startTime;
        
        logger.info(`✅ Sandwich executed successfully:`, {
          frontrunTx: result.frontrunTx,
          backrunTx: result.backrunTx,
          profit: result.profitUSD,
          executionTime: `${executionTime}ms`
        });
        
        // Track profit
        await this.profitTracker.recordProfit({
          type: 'sandwich',
          profitUSD: result.profitUSD,
          gasCostUSD: result.gasCostUSD,
          targetTx: opportunity.targetTx,
          frontrunTx: result.frontrunTx,
          backrunTx: result.backrunTx
        });
        
        // Update circuit breaker
        this.circuitBreaker.recordSuccess(result.profitUSD);
        
      } else {
        logger.error(`❌ Sandwich failed:`, result.error);
        this.circuitBreaker.recordFailure();
      }
      
    } catch (error) {
      logger.error('Error executing sandwich:', error);
      this.circuitBreaker.recordFailure();
    }
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }
    
    logger.info('Starting Sandwich Bot...');
    this.isRunning = true;
    
    // Start mempool monitoring
    await this.mempoolMonitor.start();
    
    // Start profit tracking
    await this.profitTracker.start();
    
    // Log status
    this.logStatus();
    
    logger.info('🚀 Sandwich Bot is running');
  }

  async stop() {
    logger.info('Stopping Sandwich Bot...');
    this.isRunning = false;
    
    // Stop components
    if (this.mempoolMonitor) await this.mempoolMonitor.stop();
    if (this.profitTracker) await this.profitTracker.stop();
    
    // Close provider connection
    if (this.provider) {
      await this.provider.destroy();
    }
    
    logger.info('Bot stopped');
  }

  pause() {
    logger.info('Pausing bot...');
    this.isRunning = false;
  }

  resume() {
    logger.info('Resuming bot...');
    this.isRunning = true;
  }

  logStatus() {
    setInterval(() => {
      if (!this.isRunning) return;
      
      const stats = this.profitTracker.getStats();
      logger.info('📊 Bot Status:', {
        running: this.isRunning,
        totalProfit: `${stats.totalProfitUSD.toFixed(2)} USD`,
        totalTrades: stats.totalTrades,
        successRate: `${stats.successRate.toFixed(1)}%`,
        uptime: this.getUptime()
      });
    }, 60000); // Every minute
  }

  getUptime() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}

// Main execution
async function main() {
  const bot = new SandwichBot();
  
  try {
    await bot.initialize();
    await bot.start();
    
    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down...');
      await bot.stop();
      process.exit(0);
    });
    
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down...');
      await bot.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the bot
if (require.main === module) {
  main();
}

module.exports = { SandwichBot };