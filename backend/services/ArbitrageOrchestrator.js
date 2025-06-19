import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { logger, logOpportunity } from '../utils/logger.js';
import { DEXAggregator } from './DEXAggregator.js';
import { PriceOracle } from './PriceOracle.js';
import { GasEstimator } from './GasEstimator.js';
import { PathOptimizer } from './PathOptimizer.js';

export class ArbitrageOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.cache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
    this.opportunities = new Map();
    this.isRunning = false;
    this.scanInterval = parseInt(process.env.SCAN_INTERVAL) || 1000;
    
    // Initialize components
    this.dexAggregator = new DEXAggregator();
    this.priceOracle = new PriceOracle();
    this.gasEstimator = new GasEstimator();
    this.pathOptimizer = new PathOptimizer();
    
    // Configuration
    this.config = {
      minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.05,
      maxSlippage: parseFloat(process.env.MAX_SLIPPAGE) || 2.0,
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 50000,
      gasLimit: parseInt(process.env.GAS_LIMIT) || 600000
    };
  }

  async start() {
    if (this.isRunning) {
      logger.warn('ArbitrageOrchestrator is already running');
      return;
    }

    logger.info('Starting ArbitrageOrchestrator...');
    this.isRunning = true;

    // Initialize components
    await this.dexAggregator.initialize();
    await this.priceOracle.initialize();
    await this.gasEstimator.initialize();

    // Start scanning for opportunities
    this.scanLoop();
  }

  async stop() {
    logger.info('Stopping ArbitrageOrchestrator...');
    this.isRunning = false;
    this.opportunities.clear();
  }

  async scanLoop() {
    while (this.isRunning) {
      try {
        await this.scanForOpportunities();
      } catch (error) {
        logger.error('Error in scan loop:', error);
      }
      
      await new Promise(resolve => setTimeout(resolve, this.scanInterval));
    }
  }

  async scanForOpportunities() {
    const startTime = Date.now();
    
    // Get all supported tokens
    const tokens = await this.dexAggregator.getSupportedTokens();
    
    // Get current gas price
    const gasPrice = await this.gasEstimator.getCurrentGasPrice();
    
    // Scan for arbitrage opportunities
    const opportunities = [];
    
    for (const tokenA of tokens) {
      for (const tokenB of tokens) {
        if (tokenA.address === tokenB.address) continue;
        
        try {
          const opportunity = await this.findArbitrageOpportunity(
            tokenA,
            tokenB,
            gasPrice
          );
          
          if (opportunity) {
            opportunities.push(opportunity);
          }
        } catch (error) {
          // Silently skip individual token pair errors
        }
      }
    }
    
    // Process and emit opportunities
    for (const opportunity of opportunities) {
      if (this.validateOpportunity(opportunity)) {
        const id = this.generateOpportunityId(opportunity);
        opportunity.id = id;
        opportunity.timestamp = Date.now();
        
        this.opportunities.set(id, opportunity);
        this.emit('opportunity', opportunity);
        logOpportunity(opportunity);
      }
    }
    
    const scanTime = Date.now() - startTime;
    if (opportunities.length > 0) {
      logger.info(`Found ${opportunities.length} opportunities in ${scanTime}ms`);
    }
  }

  async findArbitrageOpportunity(tokenA, tokenB, gasPrice) {
    // Get prices from all DEXs
    const prices = await this.dexAggregator.getPricesAcrossDEXs(
      tokenA.address,
      tokenB.address
    );
    
    if (prices.length < 2) return null;
    
    // Sort by price to find best buy and sell
    const sortedPrices = prices.sort((a, b) => a.price - b.price);
    const buyDEX = sortedPrices[0];
    const sellDEX = sortedPrices[sortedPrices.length - 1];
    
    // Calculate potential profit
    const priceDiff = sellDEX.price - buyDEX.price;
    const priceDiffPercent = (priceDiff / buyDEX.price) * 100;
    
    // Skip if price difference is too small
    if (priceDiffPercent < 0.5) return null;
    
    // Calculate optimal trade amount
    const optimalAmount = await this.calculateOptimalAmount(
      tokenA,
      tokenB,
      buyDEX,
      sellDEX
    );
    
    if (!optimalAmount || optimalAmount.eq(0)) return null;
    
    // Estimate gas costs
    const gasEstimate = await this.gasEstimator.estimateArbitrageGas(
      buyDEX.dex,
      sellDEX.dex,
      tokenA.address,
      tokenB.address
    );
    
    const gasCostWei = gasPrice.mul(gasEstimate);
    const gasCostUSD = await this.priceOracle.getETHPriceUSD()
      .then(ethPrice => parseFloat(ethers.formatEther(gasCostWei)) * ethPrice);
    
    // Calculate profit
    const buyAmountUSD = await this.priceOracle.getTokenPriceUSD(
      tokenA.address,
      optimalAmount
    );
    const profitUSD = buyAmountUSD * (priceDiffPercent / 100) - gasCostUSD;
    
    if (profitUSD < this.config.minProfitUSD) return null;
    
    return {
      type: 'arbitrage',
      tokenA,
      tokenB,
      buyDEX: buyDEX.dex,
      sellDEX: sellDEX.dex,
      amount: optimalAmount.toString(),
      profitUSD,
      gasCostUSD,
      gasEstimate: gasEstimate.toString(),
      path: [
        { dex: buyDEX.dex, action: 'buy', price: buyDEX.price },
        { dex: sellDEX.dex, action: 'sell', price: sellDEX.price }
      ],
      priceDiffPercent
    };
  }

  async calculateOptimalAmount(tokenA, tokenB, buyDEX, sellDEX) {
    // Get liquidity for both DEXs
    const buyLiquidity = await this.dexAggregator.getLiquidity(
      buyDEX.dex,
      tokenA.address,
      tokenB.address
    );
    
    const sellLiquidity = await this.dexAggregator.getLiquidity(
      sellDEX.dex,
      tokenA.address,
      tokenB.address
    );
    
    // Calculate maximum amount based on liquidity and slippage
    const maxBuyAmount = buyLiquidity.mul(
      Math.floor(this.config.maxSlippage * 100)
    ).div(10000);
    
    const maxSellAmount = sellLiquidity.mul(
      Math.floor(this.config.maxSlippage * 100)
    ).div(10000);
    
    // Return the smaller of the two
    return maxBuyAmount.lt(maxSellAmount) ? maxBuyAmount : maxSellAmount;
  }

  validateOpportunity(opportunity) {
    // Check minimum profit
    if (opportunity.profitUSD < this.config.minProfitUSD) {
      return false;
    }
    
    // Check if opportunity is still fresh (less than 5 seconds old)
    const age = Date.now() - opportunity.timestamp;
    if (age > 5000) {
      return false;
    }
    
    // Check if we have sufficient gas
    const gasLimit = ethers.toBigInt(opportunity.gasEstimate);
    if (gasLimit.gt(this.config.gasLimit)) {
      return false;
    }
    
    return true;
  }

  generateOpportunityId(opportunity) {
    const data = `${opportunity.type}-${opportunity.tokenA.address}-${opportunity.tokenB.address}-${opportunity.buyDEX}-${opportunity.sellDEX}-${Date.now()}`;
    return ethers.keccak256(ethers.toUtf8Bytes(data)).slice(0, 10);
  }

  async getActiveOpportunities() {
    const now = Date.now();
    const activeOpportunities = [];
    
    for (const [id, opportunity] of this.opportunities) {
      // Remove old opportunities (older than 10 seconds)
      if (now - opportunity.timestamp > 10000) {
        this.opportunities.delete(id);
        continue;
      }
      
      // Re-validate opportunity
      if (this.validateOpportunity(opportunity)) {
        activeOpportunities.push(opportunity);
      }
    }
    
    // Sort by profit
    return activeOpportunities.sort((a, b) => b.profitUSD - a.profitUSD);
  }

  getIsRunning() {
    return this.isRunning;
  }
}