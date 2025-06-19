import { ethers } from 'ethers';
import axios from 'axios';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

export class PriceOracle {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    this.cache = new NodeCache({ stdTTL: 60, checkperiod: 30 }); // 1 minute cache
    
    // Price feed sources
    this.priceSources = {
      coingecko: {
        url: 'https://api.coingecko.com/api/v3',
        enabled: true
      },
      chainlink: {
        enabled: true,
        feeds: {
          // Polygon mainnet Chainlink price feeds
          'ETH/USD': '0xF9680D99D6C9589e2a93a78A04A279e509205945',
          'BTC/USD': '0xc907E116054Ad103354f2D350FD2514433D57F6f',
          'MATIC/USD': '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
          'USDC/USD': '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
          'USDT/USD': '0x0A6513e40db6EB1b165753AD52E80663aeA50545',
          'DAI/USD': '0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D'
        }
      }
    };
    
    // Token mappings
    this.tokenMappings = {
      '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': { symbol: 'WETH', coingeckoId: 'ethereum' },
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': { symbol: 'USDC', coingeckoId: 'usd-coin' },
      '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': { symbol: 'USDT', coingeckoId: 'tether' },
      '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063': { symbol: 'DAI', coingeckoId: 'dai' },
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': { symbol: 'WMATIC', coingeckoId: 'matic-network' },
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', coingeckoId: 'wrapped-bitcoin' }
    };
    
    // Chainlink ABI
    this.chainlinkABI = [
      'function latestRoundData() external view returns (uint80 roundId, int256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
    ];
  }

  async initialize() {
    logger.info('Initializing PriceOracle...');
    
    // Pre-fetch common token prices
    await this.prefetchPrices();
    
    logger.info('PriceOracle initialized');
  }

  async getETHPriceUSD() {
    const cacheKey = 'price:ETH:USD';
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    
    try {
      // Try Chainlink first
      if (this.priceSources.chainlink.enabled) {
        const price = await this.getChainlinkPrice('ETH/USD');
        if (price) {
          this.cache.set(cacheKey, price);
          return price;
        }
      }
      
      // Fallback to CoinGecko
      if (this.priceSources.coingecko.enabled) {
        const price = await this.getCoinGeckoPrice('ethereum');
        if (price) {
          this.cache.set(cacheKey, price);
          return price;
        }
      }
      
      // Default fallback
      return 2000;
    } catch (error) {
      logger.error('Error fetching ETH price:', error);
      return 2000; // Fallback price
    }
  }

  async getTokenPriceUSD(tokenAddress, amount = ethers.parseEther('1')) {
    const mapping = this.tokenMappings[tokenAddress.toLowerCase()];
    if (!mapping) {
      logger.warn(`No price mapping for token ${tokenAddress}`);
      return 0;
    }
    
    const cacheKey = `price:${tokenAddress}:USD`;
    let pricePerToken = this.cache.get(cacheKey);
    
    if (!pricePerToken) {
      // Try Chainlink first
      const chainlinkFeed = `${mapping.symbol}/USD`;
      if (this.priceSources.chainlink.feeds[chainlinkFeed]) {
        pricePerToken = await this.getChainlinkPrice(chainlinkFeed);
      }
      
      // Fallback to CoinGecko
      if (!pricePerToken && mapping.coingeckoId) {
        pricePerToken = await this.getCoinGeckoPrice(mapping.coingeckoId);
      }
      
      if (pricePerToken) {
        this.cache.set(cacheKey, pricePerToken);
      } else {
        pricePerToken = 0;
      }
    }
    
    // Calculate total value for the amount
    const decimals = this.getTokenDecimals(tokenAddress);
    const amountFloat = parseFloat(ethers.formatUnits(amount, decimals));
    return amountFloat * pricePerToken;
  }

  async getChainlinkPrice(priceFeed) {
    try {
      const feedAddress = this.priceSources.chainlink.feeds[priceFeed];
      if (!feedAddress) return null;
      
      const priceFeedContract = new ethers.Contract(
        feedAddress,
        this.chainlinkABI,
        this.provider
      );
      
      const roundData = await priceFeedContract.latestRoundData();
      const price = parseFloat(ethers.formatUnits(roundData.price, 8)); // Chainlink uses 8 decimals
      
      // Validate price is recent (within 1 hour)
      const updatedAt = roundData.updatedAt.toNumber();
      const now = Math.floor(Date.now() / 1000);
      if (now - updatedAt > 3600) {
        logger.warn(`Chainlink price for ${priceFeed} is stale`);
        return null;
      }
      
      return price;
    } catch (error) {
      logger.error(`Error fetching Chainlink price for ${priceFeed}:`, error);
      return null;
    }
  }

  async getCoinGeckoPrice(coinId) {
    try {
      const url = `${this.priceSources.coingecko.url}/simple/price?ids=${coinId}&vs_currencies=usd`;
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data[coinId] && response.data[coinId].usd) {
        return response.data[coinId].usd;
      }
      
      return null;
    } catch (error) {
      logger.error(`Error fetching CoinGecko price for ${coinId}:`, error);
      return null;
    }
  }

  async getBatchPrices(tokenAddresses) {
    const prices = {};
    
    // Group tokens by those with CoinGecko IDs
    const coingeckoIds = [];
    const tokenToId = {};
    
    for (const address of tokenAddresses) {
      const mapping = this.tokenMappings[address.toLowerCase()];
      if (mapping && mapping.coingeckoId) {
        coingeckoIds.push(mapping.coingeckoId);
        tokenToId[mapping.coingeckoId] = address;
      }
    }
    
    // Batch fetch from CoinGecko
    if (coingeckoIds.length > 0) {
      try {
        const url = `${this.priceSources.coingecko.url}/simple/price?ids=${coingeckoIds.join(',')}&vs_currencies=usd`;
        const response = await axios.get(url, { timeout: 5000 });
        
        for (const [coinId, data] of Object.entries(response.data)) {
          const tokenAddress = tokenToId[coinId];
          if (tokenAddress && data.usd) {
            prices[tokenAddress] = data.usd;
            this.cache.set(`price:${tokenAddress}:USD`, data.usd);
          }
        }
      } catch (error) {
        logger.error('Error batch fetching prices:', error);
      }
    }
    
    // Fill in missing prices with Chainlink or defaults
    for (const address of tokenAddresses) {
      if (!prices[address]) {
        prices[address] = await this.getTokenPriceUSD(address, ethers.parseEther('1'));
      }
    }
    
    return prices;
  }

  async convertTokenAmount(fromToken, toToken, amount) {
    if (fromToken.toLowerCase() === toToken.toLowerCase()) {
      return amount;
    }
    
    const fromPriceUSD = await this.getTokenPriceUSD(fromToken, ethers.parseEther('1'));
    const toPriceUSD = await this.getTokenPriceUSD(toToken, ethers.parseEther('1'));
    
    if (!fromPriceUSD || !toPriceUSD) {
      throw new Error('Unable to fetch token prices for conversion');
    }
    
    const fromDecimals = this.getTokenDecimals(fromToken);
    const toDecimals = this.getTokenDecimals(toToken);
    
    const amountInUSD = parseFloat(ethers.formatUnits(amount, fromDecimals)) * fromPriceUSD;
    const amountInToToken = amountInUSD / toPriceUSD;
    
    return ethers.parseUnits(amountInToToken.toFixed(toDecimals), toDecimals);
  }

  getTokenDecimals(tokenAddress) {
    // Common token decimals (would fetch from contract in production)
    const decimalsMap = {
      '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': 18, // WETH
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': 6,  // USDC
      '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': 6,  // USDT
      '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063': 18, // DAI
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': 18, // WMATIC
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 8   // WBTC
    };
    
    return decimalsMap[tokenAddress.toLowerCase()] || 18;
  }

  async prefetchPrices() {
    logger.info('Pre-fetching token prices...');
    
    const tokenAddresses = Object.keys(this.tokenMappings);
    await this.getBatchPrices(tokenAddresses);
    
    logger.info('Token prices pre-fetched');
  }
}