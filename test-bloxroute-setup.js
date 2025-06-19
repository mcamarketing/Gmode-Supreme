#!/usr/bin/env node
require('dotenv').config();
const ethers = require('ethers');
const WebSocket = require('ws');

console.log('🚀 BloXroute Setup Verification for BSC MEV Bot');
console.log('================================================');

async function testBloXrouteSetup() {
  let exitCode = 0;
  
  // 1. Check environment variables
  console.log('\n1. 🔍 Checking BloXroute Configuration...');
  
  const requiredVars = [
    'RPC_URL',
    'BLOXROUTE_AUTH_HEADER',
    'BLOXROUTE_ACCOUNT_ID',
    'BOT_PRIVATE_KEY'
  ];
  
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      console.log(`   ❌ Missing: ${varName}`);
      exitCode = 1;
    } else {
      console.log(`   ✅ Found: ${varName}`);
    }
  }
  
  // 2. Test HTTP connection
  console.log('\n2. 🌐 Testing BloXroute HTTP Connection...');
  try {
    const httpUrl = process.env.FALLBACK_RPC_URLS?.split(',')[0] || 'https://bsc-mainnet.blxrbdn.com';
    const provider = new ethers.providers.JsonRpcProvider(httpUrl);
    
    const blockNumber = await provider.getBlockNumber();
    console.log(`   ✅ Connected! Latest block: ${blockNumber}`);
    
    const gasPrice = await provider.getGasPrice();
    console.log(`   ✅ Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
  } catch (error) {
    console.log(`   ❌ HTTP connection failed: ${error.message}`);
    exitCode = 1;
  }
  
  // 3. Test WebSocket connection
  console.log('\n3. 📡 Testing BloXroute WebSocket Connection...');
  try {
    await testWebSocketConnection();
    console.log('   ✅ WebSocket connection successful!');
  } catch (error) {
    console.log(`   ❌ WebSocket connection failed: ${error.message}`);
    exitCode = 1;
  }
  
  // 4. Test wallet
  console.log('\n4. 💰 Testing Wallet Configuration...');
  try {
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.FALLBACK_RPC_URLS?.split(',')[0] || 'https://bsc-mainnet.blxrbdn.com'
    );
    const wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
    
    console.log(`   ✅ Wallet address: ${wallet.address}`);
    
    const balance = await wallet.getBalance();
    const balanceEth = parseFloat(ethers.utils.formatEther(balance));
    console.log(`   💰 Balance: ${balanceEth.toFixed(4)} BNB`);
    
    if (balanceEth < 0.05) {
      console.log('   ⚠️  Warning: Low balance! Need at least 0.05 BNB for gas');
    }
    
    if (balanceEth < 0.01) {
      console.log('   ❌ Insufficient balance for trading');
      exitCode = 1;
    }
  } catch (error) {
    console.log(`   ❌ Wallet test failed: ${error.message}`);
    exitCode = 1;
  }
  
  // 5. Test DEX router connections
  console.log('\n5. 🔄 Testing DEX Router Connections...');
  const routers = {
    'PancakeSwap V2': process.env.PANCAKESWAP_ROUTER_V2,
    'BiSwap': process.env.BISWAP_ROUTER,
    'ApeSwap': process.env.APESWAP_ROUTER,
    'BakerySwap': process.env.BAKERYSWAP_ROUTER
  };
  
  for (const [name, address] of Object.entries(routers)) {
    if (address) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(
          process.env.FALLBACK_RPC_URLS?.split(',')[0]
        );
        const code = await provider.getCode(address);
        if (code !== '0x') {
          console.log(`   ✅ ${name}: ${address}`);
        } else {
          console.log(`   ❌ ${name}: Invalid contract at ${address}`);
          exitCode = 1;
        }
      } catch (error) {
        console.log(`   ❌ ${name}: Connection failed`);
        exitCode = 1;
      }
    } else {
      console.log(`   ⚠️  ${name}: Not configured`);
    }
  }
  
  // 6. Test BloXroute features
  console.log('\n6. 🎯 Testing BloXroute Features...');
  
  const features = {
    'Bundle Support': process.env.USE_BLOXROUTE_BUNDLE === 'true',
    'Private Mempool': process.env.ENABLE_PRIVATE_MEMPOOL === 'true',
    'MEV Searcher': process.env.BLOXROUTE_MEV_SEARCHER === 'true',
    'Next Validator': process.env.BLOXROUTE_NEXT_VALIDATOR === 'true'
  };
  
  for (const [feature, enabled] of Object.entries(features)) {
    console.log(`   ${enabled ? '✅' : '⚪'} ${feature}: ${enabled ? 'Enabled' : 'Disabled'}`);
  }
  
  // 7. Performance settings check
  console.log('\n7. ⚡ Performance Settings...');
  console.log(`   📊 Min Swap USD: $${process.env.MIN_SWAP_USD || 5}`);
  console.log(`   💰 Min Profit USD: $${process.env.MIN_PROFIT_USD || 0.01}`);
  console.log(`   ⛽ Gas Premium: ${process.env.GAS_PREMIUM_GWEI || 1.5} gwei`);
  console.log(`   🔄 Max Concurrent Trades: ${process.env.MAX_CONCURRENT_TRADES || 8}`);
  console.log(`   ⏱️  Scan Interval: ${process.env.SCAN_INTERVAL || 100}ms`);
  console.log(`   💸 Auto-withdraw Threshold: ${process.env.AUTO_WITHDRAW_THRESHOLD || 0.05} BNB`);
  
  // 8. Final summary
  console.log('\n8. 📋 Setup Summary...');
  if (exitCode === 0) {
    console.log('   ✅ All tests passed! BloXroute setup is ready for maximum profits!');
    console.log('\n🚀 READY TO LAUNCH:');
    console.log('   - BloXroute infrastructure: Connected');
    console.log('   - Wallet: Funded and ready');
    console.log('   - DEX routers: Accessible');
    console.log('   - Performance: Optimized for speed');
    console.log('\n💰 Expected advantages with BloXroute:');
    console.log('   - Faster transaction execution');
    console.log('   - Bundle support for sandwich attacks');
    console.log('   - Private mempool access');
    console.log('   - Lower gas costs through optimization');
    console.log('   - Higher success rates');
    
    if (process.env.USE_BLOXROUTE_BUNDLE === 'true') {
      console.log('\n📦 Bundle Features Enabled:');
      console.log(`   - Bundle price: ${process.env.BLOXROUTE_BUNDLE_PRICE || 0.001} BNB`);
      console.log('   - Atomic execution guaranteed');
      console.log('   - MEV protection for our trades');
    }
  } else {
    console.log('   ❌ Setup incomplete! Please fix the issues above.');
    console.log('\n🔧 Common fixes:');
    console.log('   - Add BloXroute auth header to .env');
    console.log('   - Fund your bot wallet with BNB');
    console.log('   - Check RPC URL format');
    console.log('   - Verify network connectivity');
  }
  
  return exitCode;
}

function testWebSocketConnection() {
  return new Promise((resolve, reject) => {
    const wsUrl = process.env.RPC_URL;
    if (!wsUrl || !wsUrl.startsWith('wss://')) {
      reject(new Error('Invalid WebSocket URL'));
      return;
    }
    
    const headers = {};
    if (process.env.BLOXROUTE_AUTH_HEADER) {
      headers['Authorization'] = process.env.BLOXROUTE_AUTH_HEADER;
    }
    
    const ws = new WebSocket(wsUrl, { headers });
    
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, 10000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      
      // Test subscription
      const subscription = {
        id: 1,
        method: 'subscribe',
        params: ['newBlocks']
      };
      
      ws.send(JSON.stringify(subscription));
      
      setTimeout(() => {
        ws.close();
        resolve();
      }, 2000);
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`   📨 Received message type: ${message.method || 'response'}`);
      } catch (e) {
        // Ignore parsing errors
      }
    });
  });
}

// Run the test
testBloXrouteSetup().then(exitCode => {
  process.exit(exitCode);
}).catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});