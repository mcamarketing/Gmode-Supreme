#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const nodemailer = require('nodemailer');

// Setup logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/profit-manager.log' }),
    new winston.transports.Console()
  ]
});

class ProfitManager {
  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(process.env.FALLBACK_RPC_URLS.split(',')[0]);
    this.wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, this.provider);
    
    // Configuration
    this.config = {
      autoWithdrawThreshold: ethers.utils.parseEther(process.env.AUTO_WITHDRAW_THRESHOLD || '0.1'),
      coldWallet: process.env.COLD_WALLET_ADDRESS,
      withdrawalPercent: 80, // Withdraw 80% of profits
      checkInterval: 60000, // Check every minute
      profitReportInterval: 3600000, // Report every hour
      emergencyWithdrawThreshold: ethers.utils.parseEther('1'), // Emergency withdraw at 1 BNB
    };
    
    // Profit tracking
    this.profits = {
      totalWithdrawn: ethers.BigNumber.from(0),
      totalEarned: ethers.BigNumber.from(0),
      sessionStart: Date.now(),
      lastWithdrawal: null,
      withdrawalHistory: [],
      hourlyProfits: new Map(),
      dailyProfits: new Map()
    };
    
    // Email setup
    this.emailEnabled = process.env.NOTIFICATION_EMAIL && process.env.EMAIL_USER && process.env.EMAIL_PASS;
    if (this.emailEnabled) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });
    }
    
    this.initialBalance = null;
  }

  async initialize() {
    logger.info('💰 Profit Manager initializing...');
    
    // Get initial balance
    this.initialBalance = await this.wallet.getBalance();
    logger.info(`Initial balance: ${ethers.utils.formatEther(this.initialBalance)} BNB`);
    
    // Load previous profit data if exists
    await this.loadProfitHistory();
    
    // Start monitoring
    this.startMonitoring();
    
    return true;
  }

  async loadProfitHistory() {
    try {
      const historyPath = path.join(__dirname, '../data/profit-history.json');
      const data = await fs.readFile(historyPath, 'utf8');
      const history = JSON.parse(data);
      
      this.profits.totalWithdrawn = ethers.BigNumber.from(history.totalWithdrawn || '0');
      this.profits.totalEarned = ethers.BigNumber.from(history.totalEarned || '0');
      this.profits.withdrawalHistory = history.withdrawalHistory || [];
      
      logger.info(`Loaded profit history: Total earned: ${ethers.utils.formatEther(this.profits.totalEarned)} BNB`);
    } catch (error) {
      logger.info('No profit history found, starting fresh');
    }
  }

  async saveProfitHistory() {
    try {
      const historyPath = path.join(__dirname, '../data/profit-history.json');
      const history = {
        totalWithdrawn: this.profits.totalWithdrawn.toString(),
        totalEarned: this.profits.totalEarned.toString(),
        withdrawalHistory: this.profits.withdrawalHistory,
        lastSaved: new Date().toISOString()
      };
      
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
    } catch (error) {
      logger.error('Failed to save profit history:', error);
    }
  }

  startMonitoring() {
    // Check for withdrawals
    setInterval(() => this.checkAndWithdraw(), this.config.checkInterval);
    
    // Generate profit reports
    setInterval(() => this.generateProfitReport(), this.config.profitReportInterval);
    
    // Emergency check (every 5 minutes)
    setInterval(() => this.emergencyCheck(), 300000);
    
    // Track hourly profits
    setInterval(() => this.trackHourlyProfit(), 3600000);
    
    // Initial checks
    this.checkAndWithdraw();
    this.generateProfitReport();
  }

  async checkAndWithdraw() {
    try {
      const currentBalance = await this.wallet.getBalance();
      
      // Calculate current profit
      const currentProfit = currentBalance.sub(this.initialBalance).add(this.profits.totalWithdrawn);
      
      if (currentProfit.gt(0)) {
        this.profits.totalEarned = currentProfit;
      }
      
      // Check if we should withdraw
      if (currentBalance.gt(this.config.autoWithdrawThreshold)) {
        await this.executeWithdrawal(currentBalance);
      }
      
      // Update metrics
      this.updateProfitMetrics(currentBalance, currentProfit);
      
    } catch (error) {
      logger.error('Error checking balance:', error);
    }
  }

  async executeWithdrawal(currentBalance) {
    try {
      // Calculate withdrawal amount
      const withdrawAmount = currentBalance.mul(this.config.withdrawalPercent).div(100);
      
      // Keep minimum for gas
      const minKeep = ethers.utils.parseEther('0.05');
      if (currentBalance.sub(withdrawAmount).lt(minKeep)) {
        // Adjust to keep minimum
        const adjusted = currentBalance.sub(minKeep);
        if (adjusted.lte(0)) return; // Not enough to withdraw
        withdrawAmount = adjusted;
      }
      
      logger.info(`💸 Withdrawing ${ethers.utils.formatEther(withdrawAmount)} BNB to cold wallet`);
      
      // Execute withdrawal
      const tx = await this.wallet.sendTransaction({
        to: this.config.coldWallet,
        value: withdrawAmount,
        gasPrice: await this.provider.getGasPrice(),
        gasLimit: 21000
      });
      
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        logger.info(`✅ Withdrawal successful! TX: ${receipt.transactionHash}`);
        
        // Update tracking
        this.profits.totalWithdrawn = this.profits.totalWithdrawn.add(withdrawAmount);
        this.profits.lastWithdrawal = Date.now();
        this.profits.withdrawalHistory.push({
          amount: withdrawAmount.toString(),
          timestamp: Date.now(),
          txHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toString()
        });
        
        // Save history
        await this.saveProfitHistory();
        
        // Send notification
        await this.sendWithdrawalNotification(withdrawAmount, receipt.transactionHash);
      }
      
    } catch (error) {
      logger.error('Withdrawal failed:', error);
      await this.sendAlert('Withdrawal Failed', `Error: ${error.message}`);
    }
  }

  async emergencyCheck() {
    try {
      const balance = await this.wallet.getBalance();
      
      // Emergency withdrawal if balance is very high
      if (balance.gt(this.config.emergencyWithdrawThreshold)) {
        logger.warn('🚨 EMERGENCY: High balance detected, forcing withdrawal');
        
        // Withdraw 90% in emergency
        const emergencyAmount = balance.mul(90).div(100);
        
        const tx = await this.wallet.sendTransaction({
          to: this.config.coldWallet,
          value: emergencyAmount,
          gasPrice: (await this.provider.getGasPrice()).mul(150).div(100), // 50% higher gas
          gasLimit: 21000
        });
        
        await tx.wait();
        logger.info(`🚨 Emergency withdrawal complete: ${tx.hash}`);
        
        await this.sendAlert('Emergency Withdrawal', 
          `Withdrew ${ethers.utils.formatEther(emergencyAmount)} BNB\nTX: ${tx.hash}`
        );
      }
      
    } catch (error) {
      logger.error('Emergency check failed:', error);
    }
  }

  async generateProfitReport() {
    try {
      const currentBalance = await this.wallet.getBalance();
      const sessionTime = (Date.now() - this.profits.sessionStart) / 1000 / 60 / 60; // hours
      
      // Calculate profits
      const totalProfit = this.profits.totalEarned;
      const profitPerHour = totalProfit.gt(0) && sessionTime > 0 
        ? parseFloat(ethers.utils.formatEther(totalProfit)) / sessionTime 
        : 0;
      
      // Calculate daily profit
      const today = new Date().toDateString();
      const todayProfit = this.profits.dailyProfits.get(today) || ethers.BigNumber.from(0);
      
      const report = `
📊 PROFIT REPORT
================
⏱️ Session Time: ${sessionTime.toFixed(2)} hours
💰 Current Balance: ${ethers.utils.formatEther(currentBalance)} BNB
📈 Total Earned: ${ethers.utils.formatEther(totalProfit)} BNB ($${(parseFloat(ethers.utils.formatEther(totalProfit)) * 300).toFixed(2)})
💸 Total Withdrawn: ${ethers.utils.formatEther(this.profits.totalWithdrawn)} BNB
⚡ Profit/Hour: ${profitPerHour.toFixed(4)} BNB ($${(profitPerHour * 300).toFixed(2)})
📅 Today's Profit: ${ethers.utils.formatEther(todayProfit)} BNB

🏦 Withdrawal History (Last 5):
${this.profits.withdrawalHistory.slice(-5).map(w => 
  `  - ${ethers.utils.formatEther(w.amount)} BNB at ${new Date(w.timestamp).toLocaleString()}`
).join('\n')}

💎 Performance:
  - Withdrawals: ${this.profits.withdrawalHistory.length}
  - Avg Withdrawal: ${this.profits.withdrawalHistory.length > 0 
    ? ethers.utils.formatEther(
        this.profits.totalWithdrawn.div(this.profits.withdrawalHistory.length)
      ) 
    : '0'} BNB
  - Time Since Last: ${this.profits.lastWithdrawal 
    ? `${((Date.now() - this.profits.lastWithdrawal) / 1000 / 60).toFixed(0)} minutes`
    : 'Never'}
      `;
      
      logger.info(report);
      
      // Send email report if enabled
      if (this.emailEnabled) {
        await this.sendEmailReport(report);
      }
      
      // Update daily profit tracking
      this.profits.dailyProfits.set(today, totalProfit);
      
    } catch (error) {
      logger.error('Failed to generate profit report:', error);
    }
  }

  updateProfitMetrics(currentBalance, currentProfit) {
    // Track hourly profits
    const hour = new Date().getHours();
    const hourKey = `${new Date().toDateString()}-${hour}`;
    
    if (!this.profits.hourlyProfits.has(hourKey)) {
      this.profits.hourlyProfits.set(hourKey, currentProfit);
    }
    
    // Clean old hourly data (keep last 24 hours)
    if (this.profits.hourlyProfits.size > 24) {
      const keys = Array.from(this.profits.hourlyProfits.keys());
      keys.slice(0, keys.length - 24).forEach(key => {
        this.profits.hourlyProfits.delete(key);
      });
    }
  }

  async sendWithdrawalNotification(amount, txHash) {
    const message = `
💸 WITHDRAWAL SUCCESSFUL!
Amount: ${ethers.utils.formatEther(amount)} BNB ($${(parseFloat(ethers.utils.formatEther(amount)) * 300).toFixed(2)})
TX: ${txHash}
Time: ${new Date().toLocaleString()}
Total Withdrawn: ${ethers.utils.formatEther(this.profits.totalWithdrawn)} BNB
    `;
    
    logger.info(message);
    
    if (this.emailEnabled) {
      await this.sendEmail('MEV Bot - Withdrawal Success', message);
    }
  }

  async sendAlert(subject, message) {
    logger.warn(`ALERT: ${subject} - ${message}`);
    
    if (this.emailEnabled) {
      await this.sendEmail(`MEV Bot Alert - ${subject}`, message);
    }
  }

  async sendEmailReport(report) {
    await this.sendEmail('MEV Bot - Hourly Profit Report', report);
  }

  async sendEmail(subject, text) {
    if (!this.emailEnabled) return;
    
    try {
      await this.transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject,
        text
      });
    } catch (error) {
      logger.error('Failed to send email:', error);
    }
  }

  trackHourlyProfit() {
    const currentHour = new Date().getHours();
    if (currentHour === 0) {
      // Reset daily profits at midnight
      this.profits.dailyProfits.clear();
    }
  }

  async getProfitStats() {
    const currentBalance = await this.wallet.getBalance();
    const totalProfit = this.profits.totalEarned;
    const sessionTime = (Date.now() - this.profits.sessionStart) / 1000 / 60 / 60;
    
    return {
      currentBalance: ethers.utils.formatEther(currentBalance),
      totalProfit: ethers.utils.formatEther(totalProfit),
      totalWithdrawn: ethers.utils.formatEther(this.profits.totalWithdrawn),
      profitPerHour: sessionTime > 0 ? parseFloat(ethers.utils.formatEther(totalProfit)) / sessionTime : 0,
      withdrawalCount: this.profits.withdrawalHistory.length,
      sessionTime
    };
  }

  async start() {
    try {
      await this.initialize();
      logger.info('🟢 Profit Manager is running!');
      logger.info(`💰 Auto-withdraw threshold: ${ethers.utils.formatEther(this.config.autoWithdrawThreshold)} BNB`);
      logger.info(`🏦 Cold wallet: ${this.config.coldWallet}`);
      
      // Keep running
      process.stdin.resume();
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }

  async shutdown() {
    logger.info('Shutting down Profit Manager...');
    
    // Final profit report
    await this.generateProfitReport();
    
    // Save history
    await this.saveProfitHistory();
    
    process.exit(0);
  }
}

// Start the profit manager
const manager = new ProfitManager();
manager.start();

// Graceful shutdown
process.on('SIGINT', () => manager.shutdown());
process.on('SIGTERM', () => manager.shutdown());