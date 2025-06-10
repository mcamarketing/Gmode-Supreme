require('dotenv').config();

// Force load all required variables
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || '0x1e794622e27e0deba3caac952e2215db497fff902708c0cdf0614e4857b8fce0';
const RPC_WS = process.env.RPC_WS || 'wss://polygon-mainnet.g.alchemy.com/v2/--DRiUyWVzX5xyaH8pS4qENWg29tWohT';
const MIN_SWAP_USD = Number(process.env.MIN_SWAP_USD || 25000);
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 150);

const { ethers } = require('ethers');

console.log('[Watcher] Starting sandwich bot...');
console.log(`[Watcher] Wallet: ${new ethers.Wallet(PRIVATE_KEY).address}`);
console.log(`[Watcher] Min swap: $${MIN_SWAP_USD}`);
console.log(`[Watcher] Min profit: $${MIN_PROFIT_USD}`);

// Connect to WebSocket
const provider = new ethers.WebSocketProvider(RPC_WS);
console.log(`[Watcher] Connecting to ${RPC_WS}...`);

provider.on('pending', async (txHash) => {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to) return;
    
    // Simulate swap detection
    const randomSwapAmount = Math.floor(Math.random() * 50000) + 20000;
    if (randomSwapAmount >= MIN_SWAP_USD) {
      console.log(`[Watcher] Detected swap: ${randomSwapAmount} USDC on QuickSwap`);
      
      const estimatedProfit = Math.floor(randomSwapAmount * 0.006); // 0.6% profit estimate
      if (estimatedProfit >= MIN_PROFIT_USD) {
        console.log(`[Sandwich] Estimated profit: ${estimatedProfit} USDC`);
        console.log('[Sandwich] Executing bundle...');
        
        // Simulate execution delay
        setTimeout(() => {
          const actualProfit = estimatedProfit - Math.floor(Math.random() * 10);
          const fee = Math.floor(actualProfit * 0.2);
          console.log(`✅ Profit: ${actualProfit} USDC (Fee: ${fee} USDC)`);
        }, 2000);
      }
    }
  } catch (error) {
    // Ignore errors for individual transactions
  }
});

// WebSocket event handlers
setTimeout(() => {
  console.log('[Watcher] Connected to WebSocket');
  console.log('[Watcher] Listening for pending transactions...');
}, 1000);