#!/usr/bin/env node

const axios = require('axios');
const ethers = require('ethers');
require('dotenv').config();

console.log('🧪 Testing Godmode Supreme Setup...\n');

const tests = {
  envVars: false,
  backendApi: false,
  websocketRpc: false,
  contractCompile: false
};

// Test 1: Environment Variables
console.log('1️⃣ Testing Environment Variables...');
try {
  const required = ['BOT_PRIVATE_KEY', 'RPC_URL', 'PLATFORM_WALLET'];
  const missing = required.filter(v => !process.env[v]);
  
  if (missing.length === 0) {
    console.log('✅ All required environment variables are set');
    tests.envVars = true;
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

// Test 3: WebSocket RPC Connection
console.log('\n3️⃣ Testing WebSocket RPC Connection...');
if (process.env.RPC_URL && process.env.RPC_URL.startsWith('ws')) {
  try {
    const provider = new ethers.providers.WebSocketProvider(process.env.RPC_URL);
    
    provider.getBlockNumber()
      .then(blockNumber => {
        console.log('✅ WebSocket RPC connection successful');
        console.log(`   Current block: ${blockNumber}`);
        tests.websocketRpc = true;
        provider._websocket.terminate();
      })
      .catch(error => {
        console.log('❌ WebSocket RPC connection failed:', error.message);
        provider._websocket.terminate();
      });
  } catch (error) {
    console.log('❌ Invalid RPC URL format');
  }
} else {
  console.log('❌ RPC_URL must be a WebSocket URL (ws:// or wss://)');
}

// Test 4: Contract Compilation
console.log('\n4️⃣ Testing Smart Contract Setup...');
const fs = require('fs');
if (fs.existsSync('./contracts/src/FlashEngine.sol')) {
  console.log('✅ Smart contracts found');
  tests.contractCompile = true;
  
  if (fs.existsSync('./artifacts')) {
    console.log('   ✅ Contracts appear to be compiled');
  } else {
    console.log('   ⚠️ Contracts not yet compiled');
    console.log('   Run: npx hardhat compile');
  }
} else {
  console.log('❌ Smart contracts not found');
}

// Summary
setTimeout(() => {
  console.log('\n📊 Test Summary:');
  console.log('================');
  
  const passed = Object.values(tests).filter(t => t).length;
  const total = Object.keys(tests).length;
  
  Object.entries(tests).forEach(([test, result]) => {
    console.log(`${result ? '✅' : '❌'} ${test}`);
  });
  
  console.log(`\nTotal: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('\n🎉 All tests passed! System is ready to run.');
    console.log('Run: ./start-system.sh');
  } else {
    console.log('\n⚠️ Some tests failed. Please fix the issues above.');
  }
  
  process.exit(passed === total ? 0 : 1);
}, 2000);