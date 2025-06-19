import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

export class MempoolListener extends EventEmitter {
  constructor() {
    super();
    this.provider = null;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
    this.reconnectInterval = parseInt(process.env.WS_RECONNECT_INTERVAL) || 5000;
    
    // Configuration
    this.config = {
      minSwapUSD: parseFloat(process.env.MIN_SWAP_USD) || 25,
      targetTokens: new Set(), // Will be populated with high-value tokens
      monitoredDEXs: new Set([
        '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // QuickSwap
        '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap
        '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap V3
      ])
    };
  }

  async connect() {
    try {
      logger.info('Connecting to mempool...');
      
      // Create WebSocket provider for real-time updates
      const wsUrl = process.env.RPC_URL;
      if (!wsUrl || !wsUrl.startsWith('ws')) {
        throw new Error('WebSocket RPC URL required for mempool monitoring');
      }
      
      this.provider = new ethers.WebSocketProvider(wsUrl);
      
      // Set up transaction listener
      await this.setupTransactionListener();
      
      // Set up block listener for confirmation
      await this.setupBlockListener();
      
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info('Connected to mempool successfully');
      
      this.emit('connected');
    } catch (error) {
      logger.error('Failed to connect to mempool:', error);
      await this.handleReconnect();
    }
  }

  async setupTransactionListener() {
    // Listen for pending transactions
    this.provider.on('pending', async (txHash) => {
      try {
        const tx = await this.provider.getTransaction(txHash);
        if (!tx) return;
        
        // Quick filter for DEX transactions
        if (!this.isRelevantTransaction(tx)) return;
        
        // Decode and analyze transaction
        const decodedTx = await this.decodeTransaction(tx);
        if (!decodedTx) return;
        
        // Check if transaction meets our criteria
        if (this.shouldEmitTransaction(decodedTx)) {
          this.emit('transaction', {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value.toString(),
            gasPrice: tx.gasPrice ? tx.gasPrice.toString() : null,
            gasLimit: tx.gasLimit.toString(),
            data: tx.data,
            decoded: decodedTx,
            timestamp: Date.now()
          });
        }
      } catch (error) {
        // Silently skip errors for individual transactions
      }
    });
  }

  async setupBlockListener() {
    // Listen for new blocks
    this.provider.on('block', async (blockNumber) => {
      try {
        const block = await this.provider.getBlock(blockNumber, true);
        if (!block) return;
        
        // Emit block event for other services
        this.emit('block', {
          number: blockNumber,
          timestamp: block.timestamp,
          gasPrice: block.baseFeePerGas ? block.baseFeePerGas.toString() : null,
          transactionCount: block.transactions.length
        });
        
        // Log mempool stats periodically
        if (blockNumber % 10 === 0) {
          logger.info(`Mempool listener active - Block ${blockNumber}`);
        }
      } catch (error) {
        logger.error('Error processing block:', error);
      }
    });
  }

  isRelevantTransaction(tx) {
    // Check if transaction is to a monitored DEX
    if (!tx.to || !this.config.monitoredDEXs.has(tx.to.toLowerCase())) {
      return false;
    }
    
    // Check if transaction has sufficient value
    const valueInEth = parseFloat(ethers.formatEther(tx.value));
    if (valueInEth < 0.01) {
      return false;
    }
    
    // Check if transaction data exists (not a simple transfer)
    if (!tx.data || tx.data === '0x') {
      return false;
    }
    
    return true;
  }

  async decodeTransaction(tx) {
    try {
      // Common DEX function signatures
      const signatures = {
        // Uniswap V2/QuickSwap/SushiSwap
        '0x38ed1739': 'swapExactTokensForTokens',
        '0x8803dbee': 'swapTokensForExactTokens',
        '0x7ff36ab5': 'swapExactETHForTokens',
        '0x4a25d94a': 'swapTokensForExactETH',
        '0x18cbafe5': 'swapExactTokensForETH',
        '0xfb3bdb41': 'swapETHForExactTokens',
        
        // Uniswap V3
        '0x414bf389': 'exactInputSingle',
        '0xdb3e2198': 'exactOutputSingle',
        '0xc04b8d59': 'exactInput',
        '0xf28c0498': 'exactOutput'
      };
      
      const selector = tx.data.slice(0, 10);
      const functionName = signatures[selector];
      
      if (!functionName) return null;
      
      // Decode based on function type
      let decoded = {
        function: functionName,
        selector,
        dex: this.getDEXName(tx.to)
      };
      
      // Add basic swap detection
      if (functionName.includes('swap')) {
        decoded.type = 'swap';
        decoded.isETHSwap = functionName.includes('ETH');
      }
      
      return decoded;
    } catch (error) {
      return null;
    }
  }

  getDEXName(address) {
    const dexMap = {
      '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff': 'QuickSwap',
      '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506': 'SushiSwap',
      '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45': 'Uniswap V3'
    };
    
    return dexMap[address] || 'Unknown';
  }

  shouldEmitTransaction(decodedTx) {
    // Emit all swap transactions for now
    return decodedTx.type === 'swap';
  }

  async disconnect() {
    logger.info('Disconnecting from mempool...');
    
    if (this.provider) {
      await this.provider.removeAllListeners();
      await this.provider.destroy();
      this.provider = null;
    }
    
    this.isConnected = false;
    this.emit('disconnected');
  }

  async handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached. Giving up.');
      this.emit('error', new Error('Failed to connect to mempool'));
      return;
    }
    
    this.reconnectAttempts++;
    logger.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    await new Promise(resolve => setTimeout(resolve, this.reconnectInterval));
    await this.connect();
  }

  getIsConnected() {
    return this.isConnected;
  }
}