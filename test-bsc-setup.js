#!/usr/bin/env node

const axios = require('axios');
const ethers = require('ethers');
require('dotenv').config();

console.log('🧪 Testing Godmode Supreme BSC Setup...\n');

const tests = {
  envVars: false,
  backendApi: false,
  websocketRpc: false,
  bscNetwork: false,
  dexRouters: false,
  gasSettings: false
};

// Test 1: Environment Variables
console.log('1️⃣ Testing BSC Environment Variables...');
try {
  const required = ['BOT_PRIVATE_KEY', 'RPC_URL', 'PLATFORM_WALLET', 'CHAIN_ID'];
  const missing = required.filter(v => !process.env[v]);
  
  if (missing.length === 0) {
    console.log('✅ All required environment variables are set');
    
    // Check if CHAIN_ID is correct for BSC
    if (process.env.CHAIN_ID === '56') {
      console.log('✅ Chain ID correctly set to BSC mainnet (56)');
      tests.envVars = true;
    } else {
      console.log(`❌ Chain ID is ${process.env.CHAIN_ID}, should be 56 for BSC mainnet`);
    }
  } else {
    console.log(`❌ Missing environment variables: ${missing.join(', ')}`);
  }
} catch (error) {
  console.log('❌ Error checking environment variables:', error.message);
}

// Test 2: Backend API
console.log('\n2️⃣ Testing Backend API...');
const backendPort = process.env.BACKEND_PORT || 3001;
axios.get(`http://localhost:${backendPort}/api/status`)
  .then(response => {
    console.log('✅ Backend API is running');
    console.log(`   Status: ${response.data.status}`);
    tests.backendApi = true;
  })
  .catch(error => {
    console.log('❌ Backend API is not accessible');
    console.log('   Run: cd backend && npm start');
  });

// Test 3: BSC WebSocket RPC Connection
console.log('\n3️⃣ Testing BSC WebSocket RPC Connection...');
if (process.env.RPC_URL && process.env.RPC_URL.startsWith('ws')) {
  try {
    const provider = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
    
    provider.getNetwork()
      .then(network => {
        if (network.chainId === 56) {
          console.log('✅ Connected to BSC mainnet');
          tests.bscNetwork = true;
        } else {
          console.log(`❌ Connected to wrong network. Chain ID: ${network.chainId} (expected 56)`);
        }
        
        return provider.getBlockNumber();
      })
      .then(blockNumber => {
        console.log(`   Current BSC block: ${blockNumber}`);
        tests.websocketRpc = true;
        
        // Test gas price
        return provider.getGasPrice();
      })
      .then(gasPrice => {
        const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
        console.log(`   Current BSC gas price: ${gasPriceGwei} gwei`);
        
        provider._websocket.terminate();
      })
      .catch(error => {
        console.log('❌ BSC RPC connection failed:', error.message);
        provider._websocket.terminate();
      });
  } catch (error) {
    console.log('❌ Invalid RPC URL format');
  }
} else {
  console.log('❌ RPC_URL must be a WebSocket URL (ws:// or wss://)');
}

// Test 4: BSC DEX Router Addresses
console.log('\n4️⃣ Testing BSC DEX Router Configuration...');
const requiredRouters = [
  { name: 'PancakeSwap', env: 'PANCAKESWAP_ROUTER_V2', expected: '0x10ED43C718714eb63d5aA57B78B54704E256024E' },
  { name: 'BiSwap', env: 'BISWAP_ROUTER', expected: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' },
  { name: 'Venus Unitroller', env: 'VENUS_UNITROLLER', expected: '0xfD36E2c2a6789Db23113685031d7F16329158384' }
];

let routersOk = true;
requiredRouters.forEach(router => {
  if (process.env[router.env]) {
    if (process.env[router.env].toLowerCase() === router.expected.toLowerCase()) {
      console.log(`✅ ${router.name} router correctly configured`);
    } else {
      console.log(`⚠️  ${router.name} router address doesn't match expected`);
      console.log(`   Expected: ${router.expected}`);
      console.log(`   Got: ${process.env[router.env]}`);
      routersOk = false;
    }
  } else {
    console.log(`❌ ${router.name} router not configured (${router.env})`);
    routersOk = false;
  }
});
tests.dexRouters = routersOk;

// Test 5: BSC Gas Settings
console.log('\n5️⃣ Testing BSC Gas Configuration...');
const minGas = parseInt(process.env.MIN_GAS_PRICE || '5');
const maxGas = parseInt(process.env.MAX_GAS_PRICE || '20');
const gasPremium = parseFloat(process.env.GAS_PREMIUM_GWEI || '1.5');

let gasOk = true;
if (minGas < 5) {
  console.log('❌ MIN_GAS_PRICE too low for BSC (minimum 5 gwei)');
  gasOk = false;
} else {
  console.log(`✅ MIN_GAS_PRICE: ${minGas} gwei`);
}

if (maxGas > 50) {
  console.log('⚠️  MAX_GAS_PRICE seems high for BSC (typical max: 20-30 gwei)');
} else {
  console.log(`✅ MAX_GAS_PRICE: ${maxGas} gwei`);
}

if (gasPremium > 5) {
  console.log('⚠️  GAS_PREMIUM_GWEI seems high for BSC');
} else {
  console.log(`✅ GAS_PREMIUM_GWEI: ${gasPremium} gwei`);
}
tests.gasSettings = gasOk;

// Test 6: Contract and Token Addresses
console.log('\n6️⃣ Testing BSC Token Addresses...');
const bscTokens = {
  'WBNB': process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  'BUSD': process.env.BUSD_ADDRESS || '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  'USDT': process.env.USDT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955'
};

console.log('BSC Token Addresses:');
Object.entries(bscTokens).forEach(([name, address]) => {
  console.log(`   ${name}: ${address}`);
});

// Summary
setTimeout(() => {
  console.log('\n📊 BSC Test Summary:');
  console.log('===================');
  
  const passed = Object.values(tests).filter(t => t).length;
  const total = Object.keys(tests).length;
  
  Object.entries(tests).forEach(([test, result]) => {
    console.log(`${result ? '✅' : '❌'} ${test}`);
  });
  
  console.log(`\nTotal: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('\n🎉 All BSC tests passed! System is ready for BSC.');
    console.log('Run: ./start-system.sh');
  } else {
    console.log('\n⚠️ Some BSC tests failed. Please fix the issues above.');
    console.log('\nCommon BSC Setup Issues:');
    console.log('- Ensure RPC_URL points to a BSC WebSocket endpoint');
    console.log('- Set CHAIN_ID=56 in your .env file');
    console.log('- Verify all BSC DEX router addresses are correct');
    console.log('- Check MIN_GAS_PRICE is at least 5 gwei');
  }
  
  process.exit(passed === total ? 0 : 1);
}, 2000);