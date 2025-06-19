require('dotenv').config();

module.exports = {
  apps: [
    // Main aggressive profit hunter - runs all strategies
    {
      name: 'profit-hunter',
      script: './bot/aggressive-profit-hunter.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        STRATEGY: 'all'
      },
      error_file: 'logs/profit-hunter-error.log',
      out_file: 'logs/profit-hunter-out.log',
      time: true
    },
    
    // Token sniper - aggressive new token hunting
    {
      name: 'token-sniper',
      script: './bot/token-sniper.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/sniper-error.log',
      out_file: 'logs/sniper-out.log',
      time: true
    },
    
    // Original sandwich bots - run 2 for redundancy
    {
      name: 'sandwich-bot-1',
      script: './bot/sandwich.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        BOT_ID: 'sandwich-1'
      },
      error_file: 'logs/sandwich-1-error.log',
      out_file: 'logs/sandwich-1-out.log',
      time: true
    },
    {
      name: 'sandwich-bot-2',
      script: './bot/sandwich.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        BOT_ID: 'sandwich-2'
      },
      error_file: 'logs/sandwich-2-error.log',
      out_file: 'logs/sandwich-2-out.log',
      time: true
    },
    
    // Liquidation scanner - aggressive settings
    {
      name: 'liquidation-scanner',
      script: './bot/liquidation.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        SCAN_INTERVAL: 3000 // 3 seconds
      },
      error_file: 'logs/liquidation-error.log',
      out_file: 'logs/liquidation-out.log',
      time: true
    },
    
    // Profit manager - auto withdrawals and reporting
    {
      name: 'profit-manager',
      script: './bot/profit-manager.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/profit-manager-error.log',
      out_file: 'logs/profit-manager-out.log',
      time: true
    },
    
    // Backend server for monitoring
    {
      name: 'backend-server',
      script: './backend/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      error_file: 'logs/backend-error.log',
      out_file: 'logs/backend-out.log',
      time: true
    },
    
    // Dashboard server
    {
      name: 'dashboard',
      script: './dashboard/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: 'logs/dashboard-error.log',
      out_file: 'logs/dashboard-out.log',
      time: true
    },
    
    // Performance monitor - tracks all profits
    {
      name: 'performance-monitor',
      script: './bot/monitor.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/monitor-error.log',
      out_file: 'logs/monitor-out.log',
      time: true
    }
  ],

  // Deploy configuration
  deploy: {
    production: {
      user: 'ubuntu',
      host: 'YOUR_SERVER_IP',
      ref: 'origin/master',
      repo: 'git@github.com:yourusername/mev-bot.git',
      path: '/home/ubuntu/mev-bot',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env production',
      env: {
        NODE_ENV: 'production'
      }
    }
  }
}; 