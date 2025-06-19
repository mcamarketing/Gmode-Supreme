import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { logger, logProfit } from '../utils/logger.js';

export class ProfitEngine extends EventEmitter {
  constructor() {
    super();
    this.cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // 1 hour cache
    this.userStats = new Map();
    this.profitHistory = [];
    this.isActive = false;
    
    // Configuration
    this.config = {
      platformFeePercent: 20, // 20% platform fee
      minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.05,
      autoWithdrawThreshold: parseFloat(process.env.AUTO_WITHDRAW_THRESHOLD) || 0.1
    };
    
    // Platform wallet
    this.platformWallet = process.env.PLATFORM_WALLET;
    if (!this.platformWallet) {
      logger.warn('Platform wallet not configured');
    }
  }

  async initialize() {
    logger.info('Initializing ProfitEngine...');
    
    // Load historical data if available
    await this.loadHistoricalData();
    
    this.isActive = true;
    logger.info('ProfitEngine initialized');
  }

  async shutdown() {
    logger.info('Shutting down ProfitEngine...');
    
    // Save current state
    await this.saveHistoricalData();
    
    this.isActive = false;
  }

  async recordProfit(transaction) {
    try {
      const { 
        userAddress, 
        opportunityId, 
        profitUSD, 
        gasCostUSD, 
        txHash,
        type 
      } = transaction;

      const netProfitUSD = profitUSD - gasCostUSD;
      
      if (netProfitUSD < this.config.minProfitUSD) {
        logger.warn(`Profit below minimum threshold: ${netProfitUSD} USD`);
        return null;
      }

      // Calculate platform fee
      const platformFeeUSD = netProfitUSD * (this.config.platformFeePercent / 100);
      const userProfitUSD = netProfitUSD - platformFeeUSD;

      // Create profit record
      const profitRecord = {
        id: this.generateProfitId(),
        userAddress,
        opportunityId,
        txHash,
        type,
        grossProfitUSD: profitUSD,
        gasCostUSD,
        netProfitUSD,
        platformFeeUSD,
        userProfitUSD,
        timestamp: Date.now()
      };

      // Update user stats
      this.updateUserStats(userAddress, profitRecord);

      // Add to history
      this.profitHistory.push(profitRecord);
      if (this.profitHistory.length > 10000) {
        this.profitHistory.shift(); // Keep last 10k records
      }

      // Log profit
      logProfit(profitRecord);

      // Emit profit event
      this.emit('profit', profitRecord);

      // Check for auto-withdraw
      if (await this.shouldAutoWithdraw(userAddress)) {
        this.emit('autoWithdraw', { userAddress, amount: userProfitUSD });
      }

      return profitRecord;
    } catch (error) {
      logger.error('Error recording profit:', error);
      throw error;
    }
  }

  updateUserStats(userAddress, profitRecord) {
    let stats = this.userStats.get(userAddress);
    
    if (!stats) {
      stats = {
        totalTrades: 0,
        profitableTrades: 0,
        totalGrossProfitUSD: 0,
        totalGasCostUSD: 0,
        totalNetProfitUSD: 0,
        totalPlatformFeeUSD: 0,
        totalUserProfitUSD: 0,
        lastTradeTimestamp: 0,
        firstTradeTimestamp: Date.now()
      };
    }

    stats.totalTrades++;
    if (profitRecord.netProfitUSD > 0) {
      stats.profitableTrades++;
    }
    stats.totalGrossProfitUSD += profitRecord.grossProfitUSD;
    stats.totalGasCostUSD += profitRecord.gasCostUSD;
    stats.totalNetProfitUSD += profitRecord.netProfitUSD;
    stats.totalPlatformFeeUSD += profitRecord.platformFeeUSD;
    stats.totalUserProfitUSD += profitRecord.userProfitUSD;
    stats.lastTradeTimestamp = Date.now();

    this.userStats.set(userAddress, stats);
    
    // Cache user stats
    this.cache.set(`user:${userAddress}:stats`, stats);
  }

  async getUserStats(userAddress) {
    // Check cache first
    const cached = this.cache.get(`user:${userAddress}:stats`);
    if (cached) return cached;

    // Get from memory
    const stats = this.userStats.get(userAddress);
    if (!stats) {
      return {
        totalTrades: 0,
        profitableTrades: 0,
        totalGrossProfitUSD: 0,
        totalGasCostUSD: 0,
        totalNetProfitUSD: 0,
        totalPlatformFeeUSD: 0,
        totalUserProfitUSD: 0,
        winRate: 0,
        averageProfitPerTrade: 0
      };
    }

    // Calculate additional metrics
    const enrichedStats = {
      ...stats,
      winRate: stats.totalTrades > 0 
        ? (stats.profitableTrades / stats.totalTrades) * 100 
        : 0,
      averageProfitPerTrade: stats.totalTrades > 0
        ? stats.totalUserProfitUSD / stats.totalTrades
        : 0
    };

    // Cache the result
    this.cache.set(`user:${userAddress}:stats`, enrichedStats);
    
    return enrichedStats;
  }

  async getUserLogs(userAddress, limit = 50) {
    const userLogs = this.profitHistory
      .filter(record => record.userAddress === userAddress)
      .slice(-limit)
      .reverse();
    
    return userLogs;
  }

  async getTopTraders(limit = 10) {
    const traders = Array.from(this.userStats.entries())
      .map(([address, stats]) => ({
        address,
        ...stats
      }))
      .sort((a, b) => b.totalUserProfitUSD - a.totalUserProfitUSD)
      .slice(0, limit);
    
    return traders;
  }

  async getPlatformStats() {
    let totalGrossProfitUSD = 0;
    let totalGasCostUSD = 0;
    let totalNetProfitUSD = 0;
    let totalPlatformFeeUSD = 0;
    let totalUserProfitUSD = 0;
    let totalTrades = 0;
    let profitableTrades = 0;

    for (const stats of this.userStats.values()) {
      totalGrossProfitUSD += stats.totalGrossProfitUSD;
      totalGasCostUSD += stats.totalGasCostUSD;
      totalNetProfitUSD += stats.totalNetProfitUSD;
      totalPlatformFeeUSD += stats.totalPlatformFeeUSD;
      totalUserProfitUSD += stats.totalUserProfitUSD;
      totalTrades += stats.totalTrades;
      profitableTrades += stats.profitableTrades;
    }

    return {
      totalTrades,
      profitableTrades,
      totalGrossProfitUSD,
      totalGasCostUSD,
      totalNetProfitUSD,
      totalPlatformFeeUSD,
      totalUserProfitUSD,
      platformWinRate: totalTrades > 0 
        ? (profitableTrades / totalTrades) * 100 
        : 0,
      averageProfitPerTrade: totalTrades > 0
        ? totalUserProfitUSD / totalTrades
        : 0,
      activeTraders: this.userStats.size
    };
  }

  async shouldAutoWithdraw(userAddress) {
    const stats = await this.getUserStats(userAddress);
    return stats.totalUserProfitUSD >= this.config.autoWithdrawThreshold;
  }

  generateProfitId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `profit_${timestamp}_${random}`;
  }

  async loadHistoricalData() {
    try {
      // In a real implementation, this would load from a database
      logger.info('Loading historical profit data...');
      // Placeholder for database loading
    } catch (error) {
      logger.error('Error loading historical data:', error);
    }
  }

  async saveHistoricalData() {
    try {
      // In a real implementation, this would save to a database
      logger.info('Saving profit data...');
      // Placeholder for database saving
    } catch (error) {
      logger.error('Error saving historical data:', error);
    }
  }

  getIsActive() {
    return this.isActive;
  }
}