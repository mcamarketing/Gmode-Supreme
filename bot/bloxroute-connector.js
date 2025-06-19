#!/usr/bin/env node
require('dotenv').config();
const WebSocket = require('ws');
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
    new winston.transports.File({ filename: 'logs/bloxroute-connector.log' }),
    new winston.transports.Console()
  ]
});

class BloXrouteConnector extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.provider = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 30;
    this.subscriptions = new Map();
    
    // BloXroute specific configuration
    this.config = {
      wsUrl: process.env.RPC_URL || 'wss://bsc-mainnet.blxrbdn.com/ws',
      httpUrl: process.env.FALLBACK_RPC_URLS.split(',')[0] || 'https://bsc-mainnet.blxrbdn.com',
      authHeader: process.env.BLOXROUTE_AUTH_HEADER,
      accountId: process.env.BLOXROUTE_ACCOUNT_ID,
      apiKey: process.env.BLOXROUTE_API_KEY,
      useMevGeth: process.env.USE_MEV_GETH === 'true',
      usePrivateMempool: process.env.ENABLE_PRIVATE_MEMPOOL === 'true',
      bundlePrice: parseFloat(process.env.BLOXROUTE_BUNDLE_PRICE) || 0.001
    };
    
    // Performance metrics
    this.metrics = {
      messagesReceived: 0,
      transactionsProcessed: 0,
      bundlesSent: 0,
      connectionUptime: 0,
      lastMessageTime: null,
      avgLatency: 0
    };
  }

  async initialize() {
    logger.info('🚀 Initializing BloXroute Connector...');
    logger.info(`📡 Connecting to: ${this.config.wsUrl}`);
    
    // Setup HTTP provider as fallback
    this.provider = new ethers.providers.JsonRpcProvider(this.config.httpUrl);
    
    // Connect to WebSocket
    await this.connect();
    
    // Setup ping/pong for connection health
    this.setupHeartbeat();
    
    return true;
  }

  async connect() {
    try {
      // Create WebSocket connection with BloXroute headers
      const headers = {};
      if (this.config.authHeader) {
        headers['Authorization'] = this.config.authHeader;
      }
      
      this.ws = new WebSocket(this.config.wsUrl, { headers });
      
      this.ws.on('open', () => {
        logger.info('✅ Connected to BloXroute BSC Gateway');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.metrics.connectionUptime = Date.now();
        
        // Subscribe to mempool stream
        this.subscribeToMempool();
        
        // Subscribe to new blocks
        this.subscribeToBlocks();
        
        // Subscribe to bundle receipts if using bundles
        if (process.env.USE_BLOXROUTE_BUNDLE === 'true') {
          this.subscribeToBundleReceipts();
        }
        
        this.emit('connected');
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });
      
      this.ws.on('error', (error) => {
        logger.error('BloXroute WebSocket error:', error);
        this.emit('error', error);
      });
      
      this.ws.on('close', (code, reason) => {
        logger.warn(`BloXroute connection closed: ${code} - ${reason}`);
        this.isConnected = false;
        this.reconnect();
      });
      
    } catch (error) {
      logger.error('Failed to connect to BloXroute:', error);
      throw error;
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.metrics.messagesReceived++;
      this.metrics.lastMessageTime = Date.now();
      
      // Handle different message types
      switch (message.method) {
        case 'subscribe':
          this.handleSubscriptionMessage(message);
          break;
        case 'newTxs':
          this.handleNewTransactions(message.params);
          break;
        case 'newBlocks':
          this.handleNewBlock(message.params);
          break;
        case 'bundleReceipt':
          this.handleBundleReceipt(message.params);
          break;
        default:
          // Handle RPC responses
          if (message.id) {
            this.handleRpcResponse(message);
          }
      }
    } catch (error) {
      logger.error('Error handling BloXroute message:', error);
    }
  }

  handleNewTransactions(params) {
    if (!params || !params.result) return;
    
    params.result.forEach(tx => {
      this.metrics.transactionsProcessed++;
      
      // Emit transaction for processing
      this.emit('pendingTransaction', {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gasPrice: tx.gasPrice,
        gasLimit: tx.gas,
        data: tx.input,
        nonce: tx.nonce,
        timestamp: Date.now(),
        source: 'bloxroute'
      });
    });
  }

  handleNewBlock(params) {
    if (!params || !params.result) return;
    
    this.emit('newBlock', {
      number: params.result.number,
      hash: params.result.hash,
      timestamp: params.result.timestamp,
      gasUsed: params.result.gasUsed,
      gasLimit: params.result.gasLimit,
      source: 'bloxroute'
    });
  }

  handleBundleReceipt(params) {
    logger.info(`📦 Bundle receipt: ${JSON.stringify(params)}`);
    this.emit('bundleReceipt', params);
  }

  subscribeToMempool() {
    const subscription = {
      id: 1,
      method: 'subscribe',
      params: [
        'newTxs',
        {
          include: ['tx_hash', 'tx_contents'],
          filters: `to in [${Object.values({
            pancakeV2: process.env.PANCAKESWAP_ROUTER_V2,
            biswap: process.env.BISWAP_ROUTER,
            apeswap: process.env.APESWAP_ROUTER,
            bakery: process.env.BAKERYSWAP_ROUTER,
            mdex: process.env.MDEX_ROUTER
          }).filter(Boolean).map(addr => `"${addr}"`).join(', ')}]`
        }
      ]
    };
    
    this.sendMessage(subscription);
    logger.info('📡 Subscribed to BloXroute mempool (DEX transactions only)');
  }

  subscribeToBlocks() {
    const subscription = {
      id: 2,
      method: 'subscribe',
      params: ['newBlocks', { include: ['header', 'tx_hashes'] }]
    };
    
    this.sendMessage(subscription);
    logger.info('📡 Subscribed to BloXroute new blocks');
  }

  subscribeToBundleReceipts() {
    const subscription = {
      id: 3,
      method: 'subscribe',
      params: ['bundleReceipt']
    };
    
    this.sendMessage(subscription);
    logger.info('📡 Subscribed to bundle receipts');
  }

  async sendBundle(transactions) {
    if (!this.isConnected) {
      throw new Error('Not connected to BloXroute');
    }
    
    const bundle = {
      id: Date.now(),
      method: 'blxr_submit_bundle',
      params: {
        transactions,
        block_number: `0x${(await this.provider.getBlockNumber() + 1).toString(16)}`,
        min_timestamp: Math.floor(Date.now() / 1000),
        max_timestamp: Math.floor(Date.now() / 1000) + 60,
        bundle_price: ethers.utils.parseEther(this.config.bundlePrice.toString()).toString()
      }
    };
    
    this.sendMessage(bundle);
    this.metrics.bundlesSent++;
    
    logger.info(`📦 Sent bundle with ${transactions.length} transactions`);
    return bundle.id;
  }

  async sendPrivateTransaction(transaction) {
    if (!this.isConnected) {
      throw new Error('Not connected to BloXroute');
    }
    
    const privateTx = {
      id: Date.now(),
      method: 'blxr_send_private_tx',
      params: {
        transaction,
        blockchain_network: 'BSC-Mainnet',
        next_validator: process.env.BLOXROUTE_NEXT_VALIDATOR === 'true'
      }
    };
    
    this.sendMessage(privateTx);
    logger.info('🔒 Sent private transaction via BloXroute');
    return privateTx.id;
  }

  sendMessage(message) {
    if (!this.isConnected) {
      logger.warn('Cannot send message: not connected to BloXroute');
      return;
    }
    
    this.ws.send(JSON.stringify(message));
  }

  setupHeartbeat() {
    setInterval(() => {
      if (this.isConnected) {
        this.ws.ping();
      }
    }, parseInt(process.env.BLOXROUTE_PING_INTERVAL) || 30000);
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    logger.info(`Reconnecting to BloXroute in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  getMetrics() {
    return {
      ...this.metrics,
      isConnected: this.isConnected,
      uptime: this.metrics.connectionUptime ? Date.now() - this.metrics.connectionUptime : 0,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  async getGasPrice() {
    // Use BloXroute's gas price oracle if available
    try {
      const gasPrice = await this.provider.getGasPrice();
      return gasPrice;
    } catch (error) {
      logger.error('Failed to get gas price:', error);
      return ethers.utils.parseUnits('5', 'gwei'); // Fallback
    }
  }

  async estimateOptimalGasPrice(priority = 'fast') {
    // BloXroute provides better gas estimation
    const baseGasPrice = await this.getGasPrice();
    
    const multipliers = {
      slow: 1.0,
      standard: 1.1,
      fast: 1.2,
      instant: 1.5
    };
    
    const multiplier = multipliers[priority] || 1.2;
    return baseGasPrice.mul(Math.floor(multiplier * 100)).div(100);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
    this.isConnected = false;
    logger.info('Disconnected from BloXroute');
  }
}

module.exports = BloXrouteConnector;