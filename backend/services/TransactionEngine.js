import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { logger, logTransaction } from '../utils/logger.js';

export class TransactionEngine extends EventEmitter {
  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.signer = null;
    this.flashEngineContract = null;
    this.isReady = false;
    
    // Configuration
    this.config = {
      flashEngineAddress: process.env.FLASH_ENGINE_ADDRESS,
      maxGasPrice: ethers.parseUnits(process.env.MAX_GAS_PRICE || '1000', 'gwei'),
      gasLimit: parseInt(process.env.GAS_LIMIT) || 600000,
      gasPremium: ethers.parseUnits(process.env.GAS_PREMIUM_GWEI || '2', 'gwei')
    };
    
    // Transaction queue
    this.pendingTransactions = new Map();
    this.executionHistory = [];
  }

  async initialize() {
    try {
      logger.info('Initializing TransactionEngine...');
      
      // Validate configuration
      if (!process.env.BOT_PRIVATE_KEY) {
        throw new Error('BOT_PRIVATE_KEY not configured');
      }
      
      if (!this.config.flashEngineAddress) {
        throw new Error('FLASH_ENGINE_ADDRESS not configured');
      }
      
      // Initialize signer
      this.signer = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
      const signerAddress = await this.signer.getAddress();
      logger.info(`Transaction signer initialized: ${signerAddress}`);
      
      // Initialize Flash Engine contract
      const flashEngineABI = [
        'function executeArbitrage(address tokenA, address tokenB, uint256 amount, address[] path, address[] routers) external',
        'function executeSandwich(address token, uint256 amountIn, address target, bytes targetCalldata) external',
        'function executeLiquidation(address user, address collateral, address debt, uint256 amount) external',
        'function withdrawProfit(address token, uint256 amount) external',
        'function getProfit(address token) view returns (uint256)',
        'event ProfitGenerated(address indexed user, uint256 amount)',
        'event ArbitrageExecuted(address indexed tokenA, address indexed tokenB, uint256 profit)',
        'event SandwichExecuted(address indexed token, uint256 profit)',
        'event LiquidationExecuted(address indexed user, uint256 profit)'
      ];
      
      this.flashEngineContract = new ethers.Contract(
        this.config.flashEngineAddress,
        flashEngineABI,
        this.signer
      );
      
      // Test connection
      const blockNumber = await this.provider.getBlockNumber();
      logger.info(`Connected to network at block ${blockNumber}`);
      
      this.isReady = true;
      logger.info('TransactionEngine initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize TransactionEngine:', error);
      throw error;
    }
  }

  async shutdown() {
    logger.info('Shutting down TransactionEngine...');
    
    // Wait for pending transactions
    if (this.pendingTransactions.size > 0) {
      logger.info(`Waiting for ${this.pendingTransactions.size} pending transactions...`);
      await Promise.all(
        Array.from(this.pendingTransactions.values()).map(tx => tx.wait())
      );
    }
    
    this.isReady = false;
  }

  async executeOpportunity(opportunityId, userAddress) {
    if (!this.isReady) {
      throw new Error('TransactionEngine not ready');
    }
    
    try {
      logger.info(`Executing opportunity ${opportunityId} for user ${userAddress}`);
      
      // Get opportunity details (in real implementation, this would fetch from a service)
      const opportunity = await this.getOpportunity(opportunityId);
      if (!opportunity) {
        throw new Error('Opportunity not found');
      }
      
      // Validate opportunity is still valid
      if (!await this.validateOpportunity(opportunity)) {
        throw new Error('Opportunity no longer valid');
      }
      
      // Check gas price
      const gasPrice = await this.getOptimalGasPrice();
      if (gasPrice.gt(this.config.maxGasPrice)) {
        throw new Error('Gas price too high');
      }
      
      // Execute based on opportunity type
      let tx;
      switch (opportunity.type) {
        case 'arbitrage':
          tx = await this.executeArbitrage(opportunity, gasPrice);
          break;
        case 'sandwich':
          tx = await this.executeSandwich(opportunity, gasPrice);
          break;
        case 'liquidation':
          tx = await this.executeLiquidation(opportunity, gasPrice);
          break;
        default:
          throw new Error(`Unknown opportunity type: ${opportunity.type}`);
      }
      
      // Track transaction
      this.pendingTransactions.set(tx.hash, tx);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      this.pendingTransactions.delete(tx.hash);
      
      // Parse results
      const result = await this.parseTransactionResult(receipt, opportunity);
      
      // Record execution
      const execution = {
        opportunityId,
        userAddress,
        txHash: tx.hash,
        type: opportunity.type,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: gasPrice.toString(),
        blockNumber: receipt.blockNumber,
        status: receipt.status === 1 ? 'success' : 'failed',
        profit: result.profit,
        timestamp: Date.now()
      };
      
      this.executionHistory.push(execution);
      logTransaction(execution);
      
      // Emit events
      this.emit('executed', execution);
      
      return {
        hash: tx.hash,
        profitUSD: result.profitUSD,
        gasUsed: receipt.gasUsed.toString()
      };
    } catch (error) {
      logger.error(`Failed to execute opportunity ${opportunityId}:`, error);
      throw error;
    }
  }

  async executeArbitrage(opportunity, gasPrice) {
    const { tokenA, tokenB, amount, path } = opportunity;
    
    // Build routers array from path
    const routers = path.map(step => this.getRouterAddress(step.dex));
    
    // Execute arbitrage through Flash Engine
    const tx = await this.flashEngineContract.executeArbitrage(
      tokenA.address,
      tokenB.address,
      amount,
      path.map(step => step.dex),
      routers,
      {
        gasLimit: this.config.gasLimit,
        gasPrice: gasPrice
      }
    );
    
    logger.info(`Arbitrage transaction sent: ${tx.hash}`);
    return tx;
  }

  async executeSandwich(opportunity, gasPrice) {
    const { token, amountIn, targetTx } = opportunity;
    
    // Execute sandwich through Flash Engine
    const tx = await this.flashEngineContract.executeSandwich(
      token,
      amountIn,
      targetTx.to,
      targetTx.data,
      {
        gasLimit: this.config.gasLimit,
        gasPrice: gasPrice.add(this.config.gasPremium) // Higher gas for priority
      }
    );
    
    logger.info(`Sandwich transaction sent: ${tx.hash}`);
    return tx;
  }

  async executeLiquidation(opportunity, gasPrice) {
    const { user, collateral, debt, amount } = opportunity;
    
    // Execute liquidation through Flash Engine
    const tx = await this.flashEngineContract.executeLiquidation(
      user,
      collateral,
      debt,
      amount,
      {
        gasLimit: this.config.gasLimit,
        gasPrice: gasPrice
      }
    );
    
    logger.info(`Liquidation transaction sent: ${tx.hash}`);
    return tx;
  }

  async getOptimalGasPrice() {
    try {
      // Get current gas price
      const gasPrice = await this.provider.getFeeData();
      
      // Add premium for faster execution
      const optimalGasPrice = gasPrice.gasPrice.add(this.config.gasPremium);
      
      // Cap at max gas price
      if (optimalGasPrice.gt(this.config.maxGasPrice)) {
        return this.config.maxGasPrice;
      }
      
      return optimalGasPrice;
    } catch (error) {
      logger.error('Error getting gas price:', error);
      return this.config.maxGasPrice;
    }
  }

  async validateOpportunity(opportunity) {
    // Basic validation - in real implementation would be more thorough
    const age = Date.now() - opportunity.timestamp;
    if (age > 10000) { // 10 seconds
      return false;
    }
    
    return true;
  }

  async parseTransactionResult(receipt, opportunity) {
    try {
      // Parse events from receipt
      let profit = ethers.BigNumber.from(0);
      let profitUSD = 0;
      
      for (const log of receipt.logs) {
        try {
          const parsed = this.flashEngineContract.interface.parseLog(log);
          
          if (parsed.name === 'ProfitGenerated') {
            profit = parsed.args.amount;
            // Convert to USD (simplified - would use price oracle in real implementation)
            profitUSD = parseFloat(ethers.formatEther(profit)) * 2000; // Assuming ETH = $2000
          }
        } catch (e) {
          // Skip logs that don't match our contract
        }
      }
      
      return { profit: profit.toString(), profitUSD };
    } catch (error) {
      logger.error('Error parsing transaction result:', error);
      return { profit: '0', profitUSD: 0 };
    }
  }

  getRouterAddress(dex) {
    const routers = {
      'QuickSwap': '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      'SushiSwap': '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      'UniswapV3': '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    };
    
    return routers[dex] || routers['QuickSwap'];
  }

  async getOpportunity(opportunityId) {
    // In real implementation, this would fetch from ArbitrageOrchestrator or database
    // For now, return a mock opportunity
    return {
      id: opportunityId,
      type: 'arbitrage',
      tokenA: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH' },
      tokenB: { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC' },
      amount: ethers.parseEther('1'),
      path: [
        { dex: 'QuickSwap', action: 'buy', price: 2000 },
        { dex: 'SushiSwap', action: 'sell', price: 2010 }
      ],
      profitUSD: 10,
      timestamp: Date.now()
    };
  }

  async getExecutionHistory(limit = 100) {
    return this.executionHistory.slice(-limit).reverse();
  }

  getIsReady() {
    return this.isReady;
  }
}