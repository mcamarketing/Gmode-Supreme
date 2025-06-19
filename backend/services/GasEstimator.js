import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

export class GasEstimator {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.cache = new NodeCache({ stdTTL: 5, checkperiod: 2 }); // 5 second cache
    
    // Gas estimation constants
    this.gasConstants = {
      // Base gas costs
      baseTransfer: 21000,
      erc20Transfer: 65000,
      
      // DEX operations
      uniswapV2Swap: 150000,
      uniswapV3Swap: 185000,
      
      // Flash loan operations
      aaveFlashLoan: 300000,
      balancerFlashLoan: 250000,
      
      // Multi-hop factors
      hopMultiplier: 1.3,
      
      // Safety margins
      safetyMargin: 1.2
    };
    
    // Historical gas data
    this.gasHistory = [];
    this.maxHistorySize = 100;
  }

  async initialize() {
    logger.info('Initializing GasEstimator...');
    
    // Start monitoring gas prices
    this.startGasMonitoring();
    
    logger.info('GasEstimator initialized');
  }

  async getCurrentGasPrice() {
    const cacheKey = 'currentGasPrice';
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    try {
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice;
      
      // Store in history
      this.addToHistory({
        gasPrice: gasPrice.toString(),
        timestamp: Date.now()
      });
      
      this.cache.set(cacheKey, gasPrice);
      return gasPrice;
    } catch (error) {
      logger.error('Error fetching gas price:', error);
      // Return last known price or default
      const lastKnown = this.gasHistory[this.gasHistory.length - 1];
      return lastKnown ? ethers.BigNumber.from(lastKnown.gasPrice) : ethers.parseUnits('50', 'gwei');
    }
  }

  async estimateArbitrageGas(buyDEX, sellDEX, tokenA, tokenB) {
    const cacheKey = `gasEstimate:arbitrage:${buyDEX}:${sellDEX}:${tokenA}:${tokenB}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    let totalGas = 0;
    
    // Flash loan gas
    totalGas += this.gasConstants.aaveFlashLoan;
    
    // Buy swap gas
    totalGas += this.getSwapGas(buyDEX);
    
    // Sell swap gas
    totalGas += this.getSwapGas(sellDEX);
    
    // Token transfers (2 for each swap)
    totalGas += this.gasConstants.erc20Transfer * 4;
    
    // Apply safety margin
    totalGas = Math.floor(totalGas * this.gasConstants.safetyMargin);
    
    const gasEstimate = ethers.BigNumber.from(totalGas);
    this.cache.set(cacheKey, gasEstimate);
    
    return gasEstimate;
  }

  async estimateSandwichGas(targetGasPrice) {
    // Sandwich attacks require 2 transactions (frontrun + backrun)
    let frontrunGas = this.gasConstants.uniswapV2Swap + this.gasConstants.erc20Transfer * 2;
    let backrunGas = this.gasConstants.uniswapV2Swap + this.gasConstants.erc20Transfer * 2;
    
    // Apply safety margin
    frontrunGas = Math.floor(frontrunGas * this.gasConstants.safetyMargin);
    backrunGas = Math.floor(backrunGas * this.gasConstants.safetyMargin);
    
    return {
      frontrun: ethers.BigNumber.from(frontrunGas),
      backrun: ethers.BigNumber.from(backrunGas),
      total: ethers.BigNumber.from(frontrunGas + backrunGas)
    };
  }

  async estimateLiquidationGas(protocol, collateralToken, debtToken) {
    let totalGas = 0;
    
    // Flash loan for liquidation
    totalGas += this.gasConstants.aaveFlashLoan;
    
    // Liquidation call (varies by protocol)
    totalGas += 350000; // Average liquidation gas
    
    // Token swaps if needed
    if (collateralToken !== debtToken) {
      totalGas += this.gasConstants.uniswapV2Swap;
    }
    
    // Token transfers
    totalGas += this.gasConstants.erc20Transfer * 4;
    
    // Apply safety margin
    totalGas = Math.floor(totalGas * this.gasConstants.safetyMargin);
    
    return ethers.BigNumber.from(totalGas);
  }

  getSwapGas(dex) {
    const gasMap = {
      'QuickSwap': this.gasConstants.uniswapV2Swap,
      'SushiSwap': this.gasConstants.uniswapV2Swap,
      'UniswapV3': this.gasConstants.uniswapV3Swap,
      'Dfyn': this.gasConstants.uniswapV2Swap,
      'Curve': 250000, // Curve is more gas intensive
      'Balancer': 200000
    };
    
    return gasMap[dex] || this.gasConstants.uniswapV2Swap;
  }

  async getPriorityFee() {
    try {
      const block = await this.provider.getBlock('latest');
      if (block && block.baseFeePerGas) {
        // Calculate priority fee based on network conditions
        const baseFee = block.baseFeePerGas;
        const priorityFee = baseFee.div(10); // 10% of base fee as priority
        
        return priorityFee;
      }
    } catch (error) {
      logger.error('Error calculating priority fee:', error);
    }
    
    // Default priority fee
    return ethers.parseUnits('2', 'gwei');
  }

  async getOptimalGasPrice(urgency = 'normal') {
    const currentGasPrice = await this.getCurrentGasPrice();
    const priorityFee = await this.getPriorityFee();
    
    let multiplier;
    switch (urgency) {
      case 'urgent':
        multiplier = 1.5;
        break;
      case 'fast':
        multiplier = 1.2;
        break;
      case 'normal':
      default:
        multiplier = 1.0;
    }
    
    const optimalPrice = currentGasPrice.add(priorityFee).mul(Math.floor(multiplier * 100)).div(100);
    
    // Cap at max gas price
    const maxGasPrice = ethers.parseUnits(process.env.MAX_GAS_PRICE || '1000', 'gwei');
    if (optimalPrice.gt(maxGasPrice)) {
      return maxGasPrice;
    }
    
    return optimalPrice;
  }

  async isGasPriceAcceptable(requiredGasPrice) {
    const maxGasPrice = ethers.parseUnits(process.env.MAX_GAS_PRICE || '1000', 'gwei');
    return requiredGasPrice.lte(maxGasPrice);
  }

  addToHistory(gasData) {
    this.gasHistory.push(gasData);
    
    if (this.gasHistory.length > this.maxHistorySize) {
      this.gasHistory.shift();
    }
  }

  getGasHistory(minutes = 5) {
    const cutoff = Date.now() - (minutes * 60 * 1000);
    return this.gasHistory.filter(data => data.timestamp >= cutoff);
  }

  getAverageGasPrice(minutes = 5) {
    const recentHistory = this.getGasHistory(minutes);
    if (recentHistory.length === 0) {
      return ethers.parseUnits('50', 'gwei'); // Default
    }
    
    const sum = recentHistory.reduce((acc, data) => {
      return acc.add(ethers.BigNumber.from(data.gasPrice));
    }, ethers.BigNumber.from(0));
    
    return sum.div(recentHistory.length);
  }

  startGasMonitoring() {
    // Monitor gas prices every 10 seconds
    setInterval(async () => {
      try {
        await this.getCurrentGasPrice();
      } catch (error) {
        logger.error('Error in gas monitoring:', error);
      }
    }, 10000);
  }
}