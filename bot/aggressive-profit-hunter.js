#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const EventEmitter = require('events');
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
    this.bundleSuccess = 0;
    this.bundleFailures = 0;
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
      bundleSuccessRate: this.bundleSuccess / (this.bundleSuccess + this.bundleFailures) * 100,
      runtime
    };
  }
}

class AggressiveProfitHunter extends EventEmitter {
  constructor() {
    super();
    this.config = this.loadConfig();
    this.bloxroute = new BloXrouteConnector();
    this.provider = null;
    this.wallet = null;
    this.profitTracker = new ProfitTracker();
    this.pendingTxs = new Map();
    this.executingTrades = new Set();
    this.knownTokens = new Map();
    this.priceCache = new Map();
    this.bundleQueue = [];
    
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
      minSwapUsd: parseFloat(process.env.MIN_SWAP_USD) || 5,
      minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD) || 0.01,
      gasPremiumGwei: parseFloat(process.env.GAS_PREMIUM_GWEI) || 1.5,
      maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 25,
      maxConcurrentTrades: parseInt(process.env.MAX_CONCURRENT_TRADES) || 8,
      scanInterval: parseInt(process.env.SCAN_INTERVAL) || 100,
      autoExecute: process.env.AUTO_EXECUTE === 'true',
      riskLevel: process.env.RISK_LEVEL || 'aggressive',
      useBundles: process.env.USE_BLOXROUTE_BUNDLE === 'true',
      usePrivateMempool: process.env.ENABLE_PRIVATE_MEMPOOL === 'true',
      bundlePrice: parseFloat(process.env.BLOXROUTE_BUNDLE_PRICE) || 0.001
    };
  }

  async initialize() {
    logger.info('🚀 Initializing BloXroute-Powered Profit Hunter...');
    logger.info(`💎 Strategies enabled: ${Object.entries(this.strategies).filter(([k,v]) => v).map(([k]) => k).join(', ')}`);
    logger.info(`🌐 Using BloXroute infrastructure for maximum speed`);
    
    // Initialize BloXroute connection
    await this.bloxroute.initialize();
    
    // Setup HTTP provider for contract calls
    this.provider = new ethers.providers.JsonRpcProvider(
      process.env.FALLBACK_RPC_URLS.split(',')[0]
    );
    
    // Setup wallet
    this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
    logger.info(`🔑 Bot wallet: ${this.wallet.address}`);
    
    // Check balance
    const balance = await this.wallet.getBalance();
    logger.info(`💰 Balance: ${ethers.utils.formatEther(balance)} BNB`);
    
    if (balance.lt(ethers.utils.parseEther('0.05'))) {
      logger.warn('⚠️ Low BNB balance! Add funds for gas fees.');
    }
    
    // Setup BloXroute event listeners
    this.setupBloXrouteListeners();
    
    // Start all profit strategies
    this.startAllStrategies();
    
    return true;
  }

  setupBloXrouteListeners() {
    // Listen for pending transactions from BloXroute
    this.bloxroute.on('pendingTransaction', async (tx) => {
      await this.processBloXrouteTransaction(tx);
    });
    
    // Listen for new blocks
    this.bloxroute.on('newBlock', (block) => {
      this.processNewBlock(block);
    });
    
    // Listen for bundle receipts
    this.bloxroute.on('bundleReceipt', (receipt) => {
      this.processBundleReceipt(receipt);
    });
    
    // Handle connection events
    this.bloxroute.on('connected', () => {
      logger.info('✅ BloXroute connection established');
    });
    
    this.bloxroute.on('error', (error) => {
      logger.error('❌ BloXroute error:', error);
    });
  }

  async processBloXrouteTransaction(tx) {
    try {
      // Quick profitability check
      const opportunity = await this.analyzePendingTx(tx);
      if (opportunity && opportunity.profit > this.config.minProfitUsd) {
        await this.executeOpportunity(opportunity);
      }
    } catch (error) {
      // Ignore errors for speed
    }
  }

  async analyzePendingTx(tx) {
    // Check if it's a DEX transaction
    const targetRouter = Object.entries(this.routers).find(([name, address]) => 
      address && tx.to && tx.to.toLowerCase() === address.toLowerCase()
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
          dex: dexName,
          useBundle: true // Use bundles for sandwich attacks
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
          dex: dexName,
          useBundle: false // Single transaction frontrun
        });
      }
    }
    
    // Return most profitable opportunity
    return opportunities.sort((a, b) => b.profit - a.profit)[0];
  }

  async executeOpportunity(opportunity) {
    if (this.executingTrades.size >= this.config.maxConcurrentTrades) {
      return; // Skip if too many concurrent trades
    }
    
    const tradeId = Date.now().toString();
    this.executingTrades.add(tradeId);
    
    try {
      logger.info(`🎯 Executing ${opportunity.type} via BloXroute: $${opportunity.profit.toFixed(2)} profit`);
      
      let success = false;
      
      if (opportunity.useBundle && this.config.useBundles) {
        success = await this.executeBundledOpportunity(opportunity);
      } else if (this.config.usePrivateMempool) {
        success = await this.executePrivateOpportunity(opportunity);
      } else {
        success = await this.executePublicOpportunity(opportunity);
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

  async executeBundledOpportunity(opportunity) {
    try {
      const transactions = [];
      
      if (opportunity.type === 'sandwich') {
        // Prepare sandwich bundle
        const frontTx = await this.prepareFrontrunTx(opportunity);
        const backTx = await this.prepareBackrunTx(opportunity);
        
        transactions.push(
          await this.wallet.signTransaction(frontTx),
          opportunity.tx.rawTransaction || await this.serializeTransaction(opportunity.tx),
          await this.wallet.signTransaction(backTx)
        );
      }
      
      // Submit bundle to BloXroute
      const bundleId = await this.bloxroute.sendBundle(transactions);
      logger.info(`📦 Bundle submitted: ${bundleId}`);
      
      return true;
    } catch (error) {
      logger.error('Bundle execution failed:', error);
      this.profitTracker.bundleFailures++;
      return false;
    }
  }

  async executePrivateOpportunity(opportunity) {
    try {
      let tx;
      
      switch (opportunity.type) {
        case 'frontrun':
          tx = await this.prepareFrontrunTx(opportunity);
          break;
        case 'backrun':
          tx = await this.prepareBackrunTx(opportunity);
          break;
        default:
          return false;
      }
      
      // Sign and send via BloXroute private mempool
      const signedTx = await this.wallet.signTransaction(tx);
      const txId = await this.bloxroute.sendPrivateTransaction(signedTx);
      
      logger.info(`🔒 Private transaction sent: ${txId}`);
      return true;
    } catch (error) {
      logger.error('Private execution failed:', error);
      return false;
    }
  }

  async executePublicOpportunity(opportunity) {
    // Fallback to regular public mempool execution
    try {
      const tx = await this.prepareFrontrunTx(opportunity);
      const receipt = await this.wallet.sendTransaction(tx);
      await receipt.wait();
      
      logger.info(`📤 Public transaction sent: ${receipt.hash}`);
      return true;
    } catch (error) {
      logger.error('Public execution failed:', error);
      return false;
    }
  }

  async prepareFrontrunTx(opportunity) {
    const { tx, decoded, dex } = opportunity;
    
    // Use BloXroute's optimal gas pricing
    const gasPrice = await this.bloxroute.estimateOptimalGasPrice('fast');
    
    // Calculate optimal amount based on victim's trade
    const frontrunAmount = this.calculateOptimalAmount(decoded);
    
    return {
      to: tx.to,
      data: this.encodeFrontrunData(decoded, frontrunAmount),
      value: decoded.method === 'swapExactETHForTokens' ? frontrunAmount : 0,
      gasPrice,
      gasLimit: 300000,
      nonce: await this.wallet.getTransactionCount('pending')
    };
  }

  async prepareBackrunTx(opportunity) {
    const { tx, decoded, dex } = opportunity;
    
    const gasPrice = await this.bloxroute.estimateOptimalGasPrice('fast');
    
    return {
      to: tx.to,
      data: this.encodeBackrunData(decoded),
      gasPrice,
      gasLimit: 300000,
      nonce: await this.wallet.getTransactionCount('pending') + 1
    };
  }

  processBundleReceipt(receipt) {
    if (receipt.success) {
      this.profitTracker.bundleSuccess++;
      logger.info(`✅ Bundle executed successfully!`);
    } else {
      this.profitTracker.bundleFailures++;
      logger.warn(`❌ Bundle failed: ${receipt.reason}`);
    }
  }

  startAllStrategies() {
    logger.info('🚀 Starting all profit strategies with BloXroute...');
    
    // BloXroute handles mempool monitoring automatically
    
    // 1. Arbitrage scanning across all DEXs
    if (this.strategies.arbitrage) {
      this.startArbitrageScanning();
    }
    
    // 2. New pair sniping
    if (this.strategies.newPairs) {
      this.startNewPairSniping();
    }
    
    // 3. Liquidation monitoring
    if (this.strategies.liquidations) {
      this.startLiquidationMonitoring();
    }
    
    // 4. Price monitoring for all tokens
    this.startPriceMonitoring();
    
    // 5. Performance monitoring
    setInterval(() => {
      this.reportPerformance();
    }, 60000); // Every minute
    
    // 6. BloXroute metrics
    setInterval(() => {
      const metrics = this.bloxroute.getMetrics();
      logger.info('📊 BloXroute Metrics:', metrics);
    }, 300000); // Every 5 minutes
  }

  reportPerformance() {
    const stats = this.profitTracker.getStats();
    const bloxrouteMetrics = this.bloxroute.getMetrics();
    
    logger.info('📈 PERFORMANCE REPORT:');
    logger.info(`💰 Total Profit: $${stats.totalProfit.toFixed(2)}`);
    logger.info(`⚡ Profit/Hour: $${stats.profitPerHour.toFixed(2)}`);
    logger.info(`📦 Bundle Success Rate: ${stats.bundleSuccessRate.toFixed(1)}%`);
    logger.info(`📡 BloXroute Messages: ${bloxrouteMetrics.messagesReceived}`);
    logger.info(`🔄 Transactions Processed: ${bloxrouteMetrics.transactionsProcessed}`);
  }

  async calculateSandwichProfit(tx, decoded, dex) {
    // Enhanced profit calculation using BloXroute data
    try {
      const amountIn = decoded.amountIn || tx.value;
      const path = decoded.path;
      
      // Estimate profit with lower gas costs due to BloXroute efficiency
      const estimatedProfitPercent = 0.3; // 0.3% average for aggressive settings
      const valueInUsd = parseFloat(ethers.utils.formatEther(amountIn)) * 300; // Assume BNB = $300
      const grossProfit = valueInUsd * estimatedProfitPercent / 100;
      
      // Lower gas costs with BloXroute bundles
      const bundleGasCost = this.config.bundlePrice * 300; // Bundle cost in USD
      const netProfit = grossProfit - bundleGasCost;
      
      return Math.max(0, netProfit);
    } catch {
      return 0;
    }
  }

  async calculateFrontrunProfit(tx, decoded, dex) {
    // Calculate frontrun profit potential
    try {
      const amountIn = decoded.amountIn || tx.value;
      const valueInUsd = parseFloat(ethers.utils.formatEther(amountIn)) * 300;
      
      // Frontrun typically captures 0.1-0.2% of trade value
      const estimatedProfitPercent = 0.15;
      const grossProfit = valueInUsd * estimatedProfitPercent / 100;
      
      // Private mempool costs
      const privateTxCost = 0.01; // $0.01 for private transaction
      const netProfit = grossProfit - privateTxCost;
      
      return Math.max(0, netProfit);
    } catch {
      return 0;
    }
  }

  // ... existing methods for arbitrage, liquidations, etc. ...

  async start() {
    try {
      await this.initialize();
      logger.info('🟢 BloXroute Profit Hunter is running!');
      logger.info(`⚡ Risk level: ${this.config.riskLevel}`);
      logger.info(`💰 Min profit threshold: $${this.config.minProfitUsd}`);
      logger.info(`🔥 Auto-execute: ${this.config.autoExecute}`);
      logger.info(`📦 Bundle support: ${this.config.useBundles}`);
      logger.info(`🔒 Private mempool: ${this.config.usePrivateMempool}`);
      
      // Keep running
      process.stdin.resume();
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }

  shutdown() {
    logger.info('Shutting down BloXroute Profit Hunter...');
    this.bloxroute.disconnect();
    const stats = this.profitTracker.getStats();
    logger.info('Final profit report:', stats);
    process.exit(0);
  }
}

// Start the BloXroute-powered profit hunter
const hunter = new AggressiveProfitHunter();
hunter.start();

// Graceful shutdown
process.on('SIGINT', () => hunter.shutdown());
process.on('SIGTERM', () => hunter.shutdown());