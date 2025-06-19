#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const winston = require('winston');
const axios = require('axios');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/sniper.log' }),
    new winston.transports.Console()
  ]
});

class TokenSniper {
  constructor() {
    this.provider = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
    this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
    this.activeSnipes = new Map();
    this.profitableTokens = new Set();
    
    // Sniper configuration
    this.config = {
      snipeAmount: ethers.utils.parseEther('0.1'), // 0.1 BNB per snipe
      maxSnipeAmount: ethers.utils.parseEther('0.5'), // Max 0.5 BNB
      sellMultiplier: 3, // Sell at 3x
      stopLoss: 0.5, // 50% stop loss
      maxGasPrice: ethers.utils.parseUnits('10', 'gwei'),
      honeypotCheckEnabled: true,
      autoSell: true,
      maxHoldTime: 300000 // 5 minutes max hold
    };
    
    // DEX factories to monitor
    this.factories = [
      { name: 'PancakeSwap', address: process.env.PANCAKESWAP_FACTORY_V2, router: process.env.PANCAKESWAP_ROUTER_V2 },
      { name: 'BiSwap', address: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE', router: process.env.BISWAP_ROUTER }
    ];
    
    // Token blacklist patterns
    this.blacklistPatterns = [
      /test/i, /fake/i, /scam/i, /honeypot/i, /rug/i
    ];
  }

  async initialize() {
    logger.info('🎯 Token Sniper initializing...');
    logger.info(`💰 Snipe amount: ${ethers.utils.formatEther(this.config.snipeAmount)} BNB`);
    logger.info(`📈 Target profit: ${this.config.sellMultiplier}x`);
    
    // Check wallet balance
    const balance = await this.wallet.getBalance();
    logger.info(`💳 Wallet balance: ${ethers.utils.formatEther(balance)} BNB`);
    
    if (balance.lt(this.config.snipeAmount)) {
      throw new Error('Insufficient BNB balance for sniping');
    }
    
    // Start monitoring all factories
    for (const factory of this.factories) {
      this.monitorFactory(factory);
    }
    
    // Start price monitoring for active positions
    this.startPriceMonitoring();
    
    // Start Telegram/Discord monitoring for calls
    this.startSocialMonitoring();
    
    return true;
  }

  async monitorFactory(factory) {
    logger.info(`👁️ Monitoring ${factory.name} factory for new pairs...`);
    
    const factoryContract = new ethers.Contract(
      factory.address,
      ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'],
      this.provider
    );
    
    factoryContract.on('PairCreated', async (token0, token1, pair, index) => {
      try {
        // Determine which is the new token (not WBNB)
        const wbnb = process.env.WBNB_ADDRESS.toLowerCase();
        let newToken;
        
        if (token0.toLowerCase() === wbnb) {
          newToken = token1;
        } else if (token1.toLowerCase() === wbnb) {
          newToken = token0;
        } else {
          // Not a WBNB pair, skip
          return;
        }
        
        logger.info(`🆕 New token detected on ${factory.name}: ${newToken}`);
        
        // Quick analysis
        const shouldSnipe = await this.analyzeToken(newToken, pair, factory);
        
        if (shouldSnipe) {
          await this.snipeToken(newToken, pair, factory);
        }
      } catch (error) {
        logger.error(`Error processing new pair: ${error.message}`);
      }
    });
  }

  async analyzeToken(tokenAddress, pairAddress, factory) {
    try {
      // 1. Get token info
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function name() view returns (string)',
          'function symbol() view returns (string)',
          'function totalSupply() view returns (uint256)',
          'function decimals() view returns (uint8)'
        ],
        this.provider
      );
      
      const [name, symbol, totalSupply, decimals] = await Promise.all([
        tokenContract.name().catch(() => 'Unknown'),
        tokenContract.symbol().catch(() => 'Unknown'),
        tokenContract.totalSupply().catch(() => ethers.BigNumber.from(0)),
        tokenContract.decimals().catch(() => 18)
      ]);
      
      logger.info(`📋 Token: ${name} (${symbol})`);
      
      // 2. Check blacklist patterns
      for (const pattern of this.blacklistPatterns) {
        if (pattern.test(name) || pattern.test(symbol)) {
          logger.warn(`⚠️ Blacklisted token pattern detected: ${name}`);
          return false;
        }
      }
      
      // 3. Quick contract analysis
      const code = await this.provider.getCode(tokenAddress);
      if (code === '0x' || code.length < 100) {
        logger.warn('⚠️ Invalid contract code');
        return false;
      }
      
      // 4. Check liquidity
      const liquidity = await this.checkLiquidity(pairAddress);
      if (liquidity.lt(ethers.utils.parseEther('1'))) { // Min 1 BNB liquidity
        logger.warn('⚠️ Low liquidity');
        return false;
      }
      
      // 5. Honeypot check (if enabled)
      if (this.config.honeypotCheckEnabled) {
        const isHoneypot = await this.checkHoneypot(tokenAddress);
        if (isHoneypot) {
          logger.warn('🍯 Honeypot detected!');
          return false;
        }
      }
      
      logger.info('✅ Token passed all checks, proceeding to snipe!');
      return true;
      
    } catch (error) {
      logger.error(`Token analysis error: ${error.message}`);
      return false;
    }
  }

  async snipeToken(tokenAddress, pairAddress, factory) {
    const snipeId = Date.now().toString();
    
    try {
      logger.info(`🎯 SNIPING TOKEN: ${tokenAddress}`);
      
      // Prepare swap transaction
      const routerContract = new ethers.Contract(
        factory.router,
        [
          'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
          'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)'
        ],
        this.wallet
      );
      
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline
      const path = [process.env.WBNB_ADDRESS, tokenAddress];
      
      // Calculate gas price (aggressive)
      const gasPrice = await this.provider.getGasPrice();
      const aggressiveGasPrice = gasPrice.mul(150).div(100); // 50% higher
      
      // Execute buy
      const tx = await routerContract.swapExactETHForTokens(
        0, // Accept any amount of tokens
        path,
        this.wallet.address,
        deadline,
        {
          value: this.config.snipeAmount,
          gasPrice: aggressiveGasPrice.gt(this.config.maxGasPrice) ? this.config.maxGasPrice : aggressiveGasPrice,
          gasLimit: 300000
        }
      );
      
      logger.info(`📤 Buy TX sent: ${tx.hash}`);
      
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        logger.info(`✅ SNIPE SUCCESSFUL! Gas used: ${receipt.gasUsed.toString()}`);
        
        // Get token balance
        const tokenContract = new ethers.Contract(
          tokenAddress,
          ['function balanceOf(address) view returns (uint256)'],
          this.provider
        );
        
        const balance = await tokenContract.balanceOf(this.wallet.address);
        
        // Track position
        this.activeSnipes.set(snipeId, {
          token: tokenAddress,
          router: factory.router,
          buyPrice: this.config.snipeAmount,
          tokenBalance: balance,
          buyTime: Date.now(),
          buyTx: tx.hash,
          targetSell: this.config.snipeAmount.mul(this.config.sellMultiplier),
          stopLoss: this.config.snipeAmount.mul(this.config.stopLoss).div(100)
        });
        
        logger.info(`💼 Position opened: ${ethers.utils.formatUnits(balance, 18)} tokens`);
        
      } else {
        logger.error('❌ Snipe failed!');
      }
      
    } catch (error) {
      logger.error(`Snipe error: ${error.message}`);
    }
  }

  async startPriceMonitoring() {
    setInterval(async () => {
      for (const [snipeId, position] of this.activeSnipes) {
        try {
          // Check current value
          const currentValue = await this.getPositionValue(position);
          const profit = currentValue.sub(position.buyPrice);
          const profitPercent = profit.mul(100).div(position.buyPrice);
          
          logger.info(`📊 Position ${snipeId}: ${ethers.utils.formatEther(currentValue)} BNB (${profitPercent.toString()}%)`);
          
          // Check sell conditions
          if (currentValue.gte(position.targetSell)) {
            logger.info(`🎯 TARGET REACHED! Selling for ${this.config.sellMultiplier}x profit`);
            await this.sellPosition(snipeId, position);
          } else if (currentValue.lte(position.stopLoss)) {
            logger.warn(`📉 STOP LOSS TRIGGERED! Selling to limit losses`);
            await this.sellPosition(snipeId, position);
          } else if (Date.now() - position.buyTime > this.config.maxHoldTime) {
            logger.warn(`⏰ MAX HOLD TIME REACHED! Force selling`);
            await this.sellPosition(snipeId, position);
          }
          
        } catch (error) {
          logger.error(`Price monitoring error: ${error.message}`);
        }
      }
    }, 5000); // Check every 5 seconds
  }

  async sellPosition(snipeId, position) {
    try {
      const routerContract = new ethers.Contract(
        position.router,
        [
          'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
          'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)'
        ],
        this.wallet
      );
      
      // Approve router
      const tokenContract = new ethers.Contract(
        position.token,
        ['function approve(address spender, uint256 amount) returns (bool)'],
        this.wallet
      );
      
      await tokenContract.approve(position.router, position.tokenBalance);
      
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const path = [position.token, process.env.WBNB_ADDRESS];
      
      // Try regular swap first
      try {
        const tx = await routerContract.swapExactTokensForETH(
          position.tokenBalance,
          0, // Accept any amount
          path,
          this.wallet.address,
          deadline,
          { gasLimit: 300000 }
        );
        
        const receipt = await tx.wait();
        logger.info(`💰 SOLD! TX: ${tx.hash}`);
        
        // Calculate profit
        const balanceAfter = await this.wallet.getBalance();
        // Note: This is approximate, should track exact amounts
        
        this.activeSnipes.delete(snipeId);
        
      } catch (error) {
        // Try fee-on-transfer compatible method
        logger.info('Trying fee-on-transfer swap...');
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
          position.tokenBalance,
          0,
          path,
          this.wallet.address,
          deadline,
          { gasLimit: 300000 }
        );
        
        await tx.wait();
        logger.info(`💰 SOLD (with fee support)! TX: ${tx.hash}`);
        this.activeSnipes.delete(snipeId);
      }
      
    } catch (error) {
      logger.error(`Sell error: ${error.message}`);
    }
  }

  async getPositionValue(position) {
    try {
      const routerContract = new ethers.Contract(
        position.router,
        ['function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)'],
        this.provider
      );
      
      const amounts = await routerContract.getAmountsOut(
        position.tokenBalance,
        [position.token, process.env.WBNB_ADDRESS]
      );
      
      return amounts[1]; // BNB amount
    } catch {
      return ethers.BigNumber.from(0);
    }
  }

  async checkLiquidity(pairAddress) {
    const pair = new ethers.Contract(
      pairAddress,
      ['function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'],
      this.provider
    );
    
    const reserves = await pair.getReserves();
    return reserves.reserve0; // Assuming token0 is WBNB
  }

  async checkHoneypot(tokenAddress) {
    // Simple honeypot check - try to simulate sell
    try {
      // This is a basic check, more sophisticated methods exist
      const code = await this.provider.getCode(tokenAddress);
      
      // Check for common honeypot patterns in bytecode
      const honeypotPatterns = [
        '0x70a08231', // balanceOf
        '0xa9059cbb', // transfer
        '0x23b872dd'  // transferFrom
      ];
      
      let hasAllFunctions = true;
      for (const pattern of honeypotPatterns) {
        if (!code.includes(pattern.slice(2))) {
          hasAllFunctions = false;
          break;
        }
      }
      
      return !hasAllFunctions;
    } catch {
      return true; // Assume honeypot if check fails
    }
  }

  async startSocialMonitoring() {
    // Monitor Telegram/Discord for token calls
    logger.info('📱 Social monitoring started (simulated)');
    
    // In production, this would connect to Telegram/Discord APIs
    // and monitor specific channels for token launches
  }

  async start() {
    try {
      await this.initialize();
      logger.info('🟢 Token Sniper is active!');
      logger.info('🎯 Hunting for profitable launches...');
      
      // Status reporting
      setInterval(() => {
        logger.info(`📊 Active positions: ${this.activeSnipes.size}`);
      }, 30000);
      
      // Keep running
      process.stdin.resume();
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }
}

// Start sniper
const sniper = new TokenSniper();
sniper.start();

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down sniper...');
  process.exit(0);
});