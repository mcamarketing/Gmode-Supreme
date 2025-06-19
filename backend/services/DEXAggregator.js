import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

export class DEXAggregator {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.cache = new NodeCache({ stdTTL: 10, checkperiod: 5 }); // 10s cache
    
    // DEX configurations
    this.dexConfigs = {
      QuickSwap: {
        router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
        type: 'uniswapV2'
      },
      SushiSwap: {
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        type: 'uniswapV2'
      },
      Dfyn: {
        router: '0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429',
        factory: '0xE7Fb3e833eFE5F9c441105EB65Ef8b261266423B',
        type: 'uniswapV2'
      }
    };
    
    // Common tokens on Polygon
    this.commonTokens = [
      { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', decimals: 18 },
      { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', decimals: 6 },
      { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
      { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', symbol: 'DAI', decimals: 18 },
      { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WMATIC', decimals: 18 },
      { address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', symbol: 'WBTC', decimals: 8 }
    ];
    
    // ABIs
    this.routerABI = [
      'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
      'function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts)'
    ];
    
    this.factoryABI = [
      'function getPair(address tokenA, address tokenB) external view returns (address pair)'
    ];
    
    this.pairABI = [
      'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
      'function token0() external view returns (address)',
      'function token1() external view returns (address)'
    ];
  }

  async initialize() {
    logger.info('Initializing DEXAggregator...');
    
    // Pre-fetch common pairs
    await this.prefetchCommonPairs();
    
    logger.info('DEXAggregator initialized');
  }

  async getSupportedTokens() {
    return this.commonTokens;
  }

  async getPricesAcrossDEXs(tokenA, tokenB) {
    const cacheKey = `prices:${tokenA}:${tokenB}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    const prices = [];
    const amountIn = ethers.parseEther('1'); // 1 token
    
    for (const [dexName, config] of Object.entries(this.dexConfigs)) {
      try {
        const price = await this.getPrice(dexName, tokenA, tokenB, amountIn);
        if (price) {
          prices.push({
            dex: dexName,
            price: parseFloat(ethers.formatEther(price)),
            amountIn: amountIn.toString(),
            amountOut: price.toString()
          });
        }
      } catch (error) {
        // Silently skip DEXs that don't have the pair
      }
    }
    
    this.cache.set(cacheKey, prices);
    return prices;
  }

  async getPrice(dexName, tokenA, tokenB, amountIn) {
    const config = this.dexConfigs[dexName];
    const router = new ethers.Contract(config.router, this.routerABI, this.provider);
    
    try {
      const amounts = await router.getAmountsOut(amountIn, [tokenA, tokenB]);
      return amounts[1]; // Return output amount
    } catch (error) {
      return null; // Pair doesn't exist or insufficient liquidity
    }
  }

  async getLiquidity(dexName, tokenA, tokenB) {
    const cacheKey = `liquidity:${dexName}:${tokenA}:${tokenB}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    const config = this.dexConfigs[dexName];
    const factory = new ethers.Contract(config.factory, this.factoryABI, this.provider);
    
    try {
      // Get pair address
      const pairAddress = await factory.getPair(tokenA, tokenB);
      if (pairAddress === ethers.constants.AddressZero) {
        return ethers.BigNumber.from(0);
      }
      
      // Get reserves
      const pair = new ethers.Contract(pairAddress, this.pairABI, this.provider);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();
      
      // Return the reserve of tokenA
      const reserveA = token0.toLowerCase() === tokenA.toLowerCase() ? reserve0 : reserve1;
      
      this.cache.set(cacheKey, reserveA);
      return reserveA;
    } catch (error) {
      logger.error(`Error getting liquidity for ${dexName}:`, error);
      return ethers.BigNumber.from(0);
    }
  }

  async findBestPath(tokenA, tokenB, amount) {
    const directPaths = [];
    const multiHopPaths = [];
    
    // Check direct paths
    for (const dexName of Object.keys(this.dexConfigs)) {
      const price = await this.getPrice(dexName, tokenA, tokenB, amount);
      if (price) {
        directPaths.push({
          dex: dexName,
          path: [tokenA, tokenB],
          amountOut: price,
          hops: 1
        });
      }
    }
    
    // Check multi-hop paths through common intermediary tokens
    const intermediaryTokens = ['0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619']; // WETH
    
    for (const intermediate of intermediaryTokens) {
      if (intermediate === tokenA || intermediate === tokenB) continue;
      
      for (const dexName of Object.keys(this.dexConfigs)) {
        try {
          const router = new ethers.Contract(
            this.dexConfigs[dexName].router,
            this.routerABI,
            this.provider
          );
          
          const amounts = await router.getAmountsOut(
            amount,
            [tokenA, intermediate, tokenB]
          );
          
          if (amounts[2]) {
            multiHopPaths.push({
              dex: dexName,
              path: [tokenA, intermediate, tokenB],
              amountOut: amounts[2],
              hops: 2
            });
          }
        } catch (error) {
          // Skip if path doesn't exist
        }
      }
    }
    
    // Combine and sort by output amount
    const allPaths = [...directPaths, ...multiHopPaths];
    allPaths.sort((a, b) => b.amountOut.sub(a.amountOut));
    
    return allPaths[0] || null;
  }

  async prefetchCommonPairs() {
    logger.info('Pre-fetching common token pairs...');
    
    const fetchPromises = [];
    
    for (let i = 0; i < this.commonTokens.length; i++) {
      for (let j = i + 1; j < this.commonTokens.length; j++) {
        const tokenA = this.commonTokens[i].address;
        const tokenB = this.commonTokens[j].address;
        
        fetchPromises.push(
          this.getPricesAcrossDEXs(tokenA, tokenB).catch(() => null)
        );
      }
    }
    
    await Promise.all(fetchPromises);
    logger.info('Common pairs pre-fetched');
  }

  async getTokenInfo(address) {
    // Check if it's a known token
    const known = this.commonTokens.find(
      t => t.address.toLowerCase() === address.toLowerCase()
    );
    
    if (known) return known;
    
    // Otherwise fetch from blockchain
    const tokenABI = [
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
      'function name() view returns (string)'
    ];
    
    try {
      const token = new ethers.Contract(address, tokenABI, this.provider);
      const [symbol, decimals] = await Promise.all([
        token.symbol(),
        token.decimals()
      ]);
      
      return { address, symbol, decimals };
    } catch (error) {
      logger.error(`Error fetching token info for ${address}:`, error);
      return null;
    }
  }
}