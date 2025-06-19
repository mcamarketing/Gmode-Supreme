import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

export class PathOptimizer {
  constructor() {
    this.maxHops = 3; // Maximum number of hops in a path
    this.minLiquidityUSD = 10000; // Minimum liquidity required
    
    // Graph representation of token connections
    this.tokenGraph = new Map();
    
    // Common intermediate tokens for routing
    this.hubTokens = [
      '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC
      '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
    ];
  }

  async findOptimalPath(tokenA, tokenB, amount, dexAggregator, priceOracle) {
    try {
      // Get all possible paths
      const allPaths = await this.findAllPaths(
        tokenA,
        tokenB,
        amount,
        dexAggregator
      );
      
      if (allPaths.length === 0) {
        logger.warn(`No paths found from ${tokenA} to ${tokenB}`);
        return null;
      }
      
      // Evaluate each path
      const evaluatedPaths = await Promise.all(
        allPaths.map(path => this.evaluatePath(path, amount, dexAggregator, priceOracle))
      );
      
      // Filter out invalid paths
      const validPaths = evaluatedPaths.filter(path => path && path.isValid);
      
      if (validPaths.length === 0) {
        logger.warn(`No valid paths found from ${tokenA} to ${tokenB}`);
        return null;
      }
      
      // Sort by profit (considering gas costs)
      validPaths.sort((a, b) => b.netProfitUSD - a.netProfitUSD);
      
      // Return the most profitable path
      return validPaths[0];
    } catch (error) {
      logger.error('Error finding optimal path:', error);
      return null;
    }
  }

  async findAllPaths(tokenA, tokenB, amount, dexAggregator) {
    const paths = [];
    
    // Direct path
    const directPath = await this.findDirectPath(tokenA, tokenB, dexAggregator);
    if (directPath) {
      paths.push(directPath);
    }
    
    // Multi-hop paths through hub tokens
    for (const hubToken of this.hubTokens) {
      if (hubToken === tokenA || hubToken === tokenB) continue;
      
      const multiHopPath = await this.findMultiHopPath(
        tokenA,
        tokenB,
        hubToken,
        dexAggregator
      );
      
      if (multiHopPath) {
        paths.push(multiHopPath);
      }
    }
    
    // Triangle arbitrage paths (A -> B -> C -> A)
    const trianglePaths = await this.findTrianglePaths(
      tokenA,
      tokenB,
      dexAggregator
    );
    paths.push(...trianglePaths);
    
    return paths;
  }

  async findDirectPath(tokenA, tokenB, dexAggregator) {
    const prices = await dexAggregator.getPricesAcrossDEXs(tokenA, tokenB);
    
    if (prices.length === 0) return null;
    
    // Find best price
    const bestPrice = prices.reduce((best, current) => 
      current.price > best.price ? current : best
    );
    
    return {
      type: 'direct',
      tokens: [tokenA, tokenB],
      dexs: [bestPrice.dex],
      hops: 1,
      estimatedOutput: bestPrice.amountOut
    };
  }

  async findMultiHopPath(tokenA, tokenB, intermediate, dexAggregator) {
    // First hop: A -> Intermediate
    const firstHopPrices = await dexAggregator.getPricesAcrossDEXs(tokenA, intermediate);
    if (firstHopPrices.length === 0) return null;
    
    // Second hop: Intermediate -> B
    const secondHopPrices = await dexAggregator.getPricesAcrossDEXs(intermediate, tokenB);
    if (secondHopPrices.length === 0) return null;
    
    // Find best combination
    let bestPath = null;
    let bestOutput = ethers.BigNumber.from(0);
    
    for (const firstHop of firstHopPrices) {
      for (const secondHop of secondHopPrices) {
        // Calculate output amount through the path
        const intermediateAmount = ethers.BigNumber.from(firstHop.amountOut);
        const finalAmount = intermediateAmount.mul(secondHop.amountOut).div(ethers.parseEther('1'));
        
        if (finalAmount.gt(bestOutput)) {
          bestOutput = finalAmount;
          bestPath = {
            type: 'multihop',
            tokens: [tokenA, intermediate, tokenB],
            dexs: [firstHop.dex, secondHop.dex],
            hops: 2,
            estimatedOutput: finalAmount.toString()
          };
        }
      }
    }
    
    return bestPath;
  }

  async findTrianglePaths(tokenA, tokenB, dexAggregator) {
    const paths = [];
    
    // Try triangle with each hub token
    for (const tokenC of this.hubTokens) {
      if (tokenC === tokenA || tokenC === tokenB) continue;
      
      try {
        // Path: A -> B -> C -> A
        const leg1 = await dexAggregator.getPricesAcrossDEXs(tokenA, tokenB);
        const leg2 = await dexAggregator.getPricesAcrossDEXs(tokenB, tokenC);
        const leg3 = await dexAggregator.getPricesAcrossDEXs(tokenC, tokenA);
        
        if (leg1.length > 0 && leg2.length > 0 && leg3.length > 0) {
          // Find best DEX for each leg
          const bestLeg1 = leg1.reduce((best, current) => 
            current.price > best.price ? current : best
          );
          const bestLeg2 = leg2.reduce((best, current) => 
            current.price > best.price ? current : best
          );
          const bestLeg3 = leg3.reduce((best, current) => 
            current.price > best.price ? current : best
          );
          
          paths.push({
            type: 'triangle',
            tokens: [tokenA, tokenB, tokenC, tokenA],
            dexs: [bestLeg1.dex, bestLeg2.dex, bestLeg3.dex],
            hops: 3,
            legs: [bestLeg1, bestLeg2, bestLeg3]
          });
        }
      } catch (error) {
        // Skip this triangle
      }
    }
    
    return paths;
  }

  async evaluatePath(path, inputAmount, dexAggregator, priceOracle) {
    try {
      let currentAmount = inputAmount;
      let totalGasEstimate = ethers.BigNumber.from(0);
      
      // Calculate output amount through the path
      for (let i = 0; i < path.hops; i++) {
        const tokenIn = path.tokens[i];
        const tokenOut = path.tokens[i + 1];
        const dex = path.dexs[i];
        
        // Get liquidity to check slippage
        const liquidity = await dexAggregator.getLiquidity(dex, tokenIn, tokenOut);
        if (liquidity.lt(ethers.parseEther('1000'))) {
          return { isValid: false, reason: 'Insufficient liquidity' };
        }
        
        // Estimate gas for this hop
        const hopGas = this.estimateHopGas(dex);
        totalGasEstimate = totalGasEstimate.add(hopGas);
        
        // Update current amount (simplified - in reality would calculate actual output)
        if (path.type === 'triangle' && path.legs) {
          currentAmount = ethers.BigNumber.from(path.legs[i].amountOut);
        }
      }
      
      // Calculate profit in USD
      const outputAmount = path.estimatedOutput ? 
        ethers.BigNumber.from(path.estimatedOutput) : 
        currentAmount;
      
      const inputUSD = await priceOracle.getTokenPriceUSD(path.tokens[0], inputAmount);
      const outputUSD = await priceOracle.getTokenPriceUSD(
        path.tokens[path.tokens.length - 1], 
        outputAmount
      );
      
      // Calculate gas cost in USD
      const gasPrice = await dexAggregator.provider.getFeeData();
      const gasCostWei = totalGasEstimate.mul(gasPrice.gasPrice);
      const ethPrice = await priceOracle.getETHPriceUSD();
      const gasCostUSD = parseFloat(ethers.formatEther(gasCostWei)) * ethPrice;
      
      // Calculate net profit
      const grossProfitUSD = outputUSD - inputUSD;
      const netProfitUSD = grossProfitUSD - gasCostUSD;
      
      return {
        isValid: true,
        path,
        inputAmount: inputAmount.toString(),
        outputAmount: outputAmount.toString(),
        inputUSD,
        outputUSD,
        grossProfitUSD,
        gasCostUSD,
        netProfitUSD,
        profitPercent: (grossProfitUSD / inputUSD) * 100,
        gasEstimate: totalGasEstimate.toString()
      };
    } catch (error) {
      logger.error('Error evaluating path:', error);
      return { isValid: false, reason: error.message };
    }
  }

  estimateHopGas(dex) {
    const gasEstimates = {
      'QuickSwap': 150000,
      'SushiSwap': 150000,
      'UniswapV3': 185000,
      'Dfyn': 150000,
      'Curve': 250000,
      'Balancer': 200000
    };
    
    return ethers.BigNumber.from(gasEstimates[dex] || 150000);
  }

  async optimizeAmountForPath(path, minAmount, maxAmount, dexAggregator, priceOracle) {
    // Binary search for optimal amount
    let low = minAmount;
    let high = maxAmount;
    let optimalAmount = minAmount;
    let maxProfit = 0;
    
    while (low.lt(high)) {
      const mid = low.add(high).div(2);
      
      const evaluation = await this.evaluatePath(path, mid, dexAggregator, priceOracle);
      
      if (evaluation.isValid && evaluation.netProfitUSD > maxProfit) {
        maxProfit = evaluation.netProfitUSD;
        optimalAmount = mid;
      }
      
      // Adjust search range based on slippage
      if (evaluation.isValid) {
        low = mid.add(1);
      } else {
        high = mid.sub(1);
      }
    }
    
    return {
      amount: optimalAmount,
      expectedProfit: maxProfit
    };
  }
}