#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Setting up Godmode Supreme MEV Bot...\n');

// Check if .env exists
const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

if (!fs.existsSync(envPath)) {
  console.log('📝 Creating .env file from template...');
  
  const envTemplate = `# Network Configuration
NETWORK=polygon
RPC_URL=wss://polygon-mainnet.g.alchemy.com/v2/your-api-key
FALLBACK_RPC_URLS=https://polygon-rpc.com,https://rpc-mainnet.matic.network

# Bot Configuration
BOT_PRIVATE_KEY=your_private_key_here
FLASH_ENGINE_ADDRESS=deployed_contract_address_here
MIN_SWAP_USD=25
MIN_PROFIT_USD=0.05
GAS_PREMIUM_GWEI=2.0
MAX_GAS_PRICE=1000
GAS_LIMIT=600000
MAX_SLIPPAGE=2.0
MIN_LIQUIDITY=50000

# Wallet Management
PLATFORM_WALLET=platform_fee_wallet_address
COLD_WALLET_ADDRESS=cold_storage_wallet_address
WALLET_ROTATION_TIME=1800000
WALLET_ROTATION_TRADES=50

# System Configuration
SCAN_INTERVAL=1000
SYNC_INTERVAL=500
MAX_ANOMALIES=5
PROFIT_THRESHOLD=0.05
AUTO_WITHDRAW_THRESHOLD=0.1

# Connection Settings
WS_RECONNECT_INTERVAL=5000
MAX_RECONNECT_ATTEMPTS=10

# API Keys (Optional)
POLYGONSCAN_API_KEY=your_polygonscan_api_key

# Email Notifications (Optional)
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
EMAIL_TO=alerts@yourdomain.com
`;

  fs.writeFileSync(envPath, envTemplate);
  console.log('✅ .env file created. Please update it with your configuration.\n');
} else {
  console.log('✅ .env file already exists.\n');
}

// Create necessary directories
const dirs = [
  'logs',
  'cache',
  'artifacts',
  'dist',
  'dist-orch'
];

dirs.forEach(dir => {
  const dirPath = path.join(__dirname, '..', dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

console.log('\n📦 Installing dependencies...\n');

// Install main dependencies
try {
  console.log('Installing main dependencies...');
  execSync('npm install', { stdio: 'inherit' });
  
  console.log('\nInstalling backend dependencies...');
  execSync('cd backend && npm install', { stdio: 'inherit' });
  
  console.log('\n✅ Dependencies installed successfully!\n');
} catch (error) {
  console.error('❌ Error installing dependencies:', error.message);
  console.log('\nPlease run the following commands manually:');
  console.log('  npm install');
  console.log('  cd backend && npm install');
}

console.log('\n🎉 Setup complete! Next steps:\n');
console.log('1. Update the .env file with your configuration');
console.log('2. Deploy the FlashEngine contract:');
console.log('   npx hardhat run scripts/deploy-flashengine.ts --network polygon');
console.log('3. Start the backend server:');
console.log('   npm run backend:dev');
console.log('4. Start the frontend:');
console.log('   npm run dev');
console.log('\n📚 Documentation: https://github.com/yourusername/godmode-supreme');
console.log('💬 Support: support@godmode.ai\n');