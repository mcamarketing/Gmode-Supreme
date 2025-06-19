#!/bin/bash

echo "� GODMODE SUPREME - MAXIMUM PROFIT MODE 💰"
echo "=========================================="
echo ""

# Check if running with proper permissions
if [ "$EUID" -eq 0 ]; then 
   echo "⚠️  Warning: Running as root is not recommended"
fi

# Validate environment
echo "🔍 Validating environment..."
node bot/scripts/validate-env.js
if [ $? -ne 0 ]; then
    echo "❌ Environment validation failed! Please check your .env file"
    exit 1
fi

# Check dependencies
echo "📦 Checking dependencies..."
node bot/scripts/check-dependencies.js
if [ $? -ne 0 ]; then
    echo "❌ Missing dependencies! Run: npm install"
    exit 1
fi

# Create necessary directories
echo "� Creating directories..."
mkdir -p logs
mkdir -p data
mkdir -p contracts/artifacts

# Test BloXroute connection
echo "🌐 Testing BloXroute connection..."
node test-bloxroute-setup.js
if [ $? -ne 0 ]; then
    echo "❌ BloXroute connection test failed!"
    echo "Please check your BloXroute credentials and network connectivity"
    exit 1
fi

# Check wallet balance
echo "💰 Checking wallet balance..."
BALANCE=$(node -e "
const ethers = require('ethers');
require('dotenv').config();
const provider = new ethers.providers.JsonRpcProvider(process.env.FALLBACK_RPC_URLS.split(',')[0]);
const wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
wallet.getBalance().then(b => console.log(ethers.utils.formatEther(b)));
" 2>/dev/null)

echo "Wallet balance: $BALANCE BNB"

# Warning if balance is low
if (( $(echo "$BALANCE < 0.1" | bc -l) )); then
    echo "⚠️  WARNING: Low BNB balance! You need at least 0.1 BNB for gas fees"
    echo "Send BNB to your bot wallet to start earning"
fi

# Stop any existing PM2 processes
echo "🛑 Stopping existing processes..."
pm2 stop all 2>/dev/null
pm2 delete all 2>/dev/null

# Clear old logs
echo "🧹 Clearing old logs..."
find logs -name "*.log" -mtime +7 -delete 2>/dev/null

# Deploy smart contract if needed
if [ -z "$FLASH_ENGINE_ADDRESS" ] || [ "$FLASH_ENGINE_ADDRESS" = "0x0000000000000000000000000000000000000000" ]; then
    echo "📜 Deploying FlashEngine contract..."
    npm run deploy
    if [ $? -ne 0 ]; then
        echo "❌ Contract deployment failed!"
        exit 1
    fi
fi

echo ""
echo "🚀 LAUNCHING PROFIT HUNTING SYSTEMS..."
echo "====================================="
echo ""

# Start all bots with PM2
pm2 start ecosystem.config.cjs

# Give processes time to start
sleep 5

# Show status
echo ""
echo "📊 System Status:"
pm2 status

echo ""
echo "✅ ALL SYSTEMS ONLINE - HUNTING FOR PROFITS!"
echo ""
echo "💎 PROFIT OPTIMIZATION ACTIVE:"
echo "  - Aggressive Profit Hunter: ALL strategies enabled"
echo "  - Token Sniper: Monitoring new launches"
echo "  - Sandwich Bots: 2 instances running"
echo "  - Liquidation Scanner: Monitoring lending protocols"
echo "  - Profit Manager: Auto-withdrawing profits"
echo ""
echo "📊 Monitor profits with: pm2 logs profit-manager"
echo "� View all logs: pm2 logs"
echo "📊 Check status: pm2 status"
echo "� Stop all: pm2 stop all"
echo ""
echo "� SETTINGS:"
echo "  - Min Swap: $10 USD"
echo "  - Min Profit: $0.02 USD"
echo "  - Auto-withdraw: 0.1 BNB threshold"
echo "  - Withdrawal: 80% to cold wallet"
echo ""
echo "⚡ ACTIVE STRATEGIES:"
echo "  ✓ Sandwich attacks (front + back running)"
echo "  ✓ Multi-DEX arbitrage"
echo "  ✓ New token sniping"
echo "  ✓ Liquidation hunting"
echo "  ✓ Flash loan arbitrage"
echo ""

# Monitor initial performance
echo "🔍 Monitoring initial performance..."
sleep 10

# Check for errors
ERROR_COUNT=$(pm2 ls | grep -c "errored")
if [ $ERROR_COUNT -gt 0 ]; then
    echo "⚠️  WARNING: Some processes have errors!"
    echo "Check logs with: pm2 logs"
else
    echo "✅ All systems running smoothly!"
fi

echo ""
echo "🎯 Ready to make profits! Good hunting! 💰"
echo ""

# Optional: Open monitoring dashboard
if command -v xdg-open &> /dev/null; then
    echo "Opening dashboard in browser..."
    sleep 3
    xdg-open http://localhost:3000 &
elif command -v open &> /dev/null; then
    echo "Opening dashboard in browser..."
    sleep 3
    open http://localhost:3000 &
fi

# Keep script running to show logs
echo "📜 Showing live profit logs (Ctrl+C to exit):"
echo "============================================"
pm2 logs profit-hunter --lines 50