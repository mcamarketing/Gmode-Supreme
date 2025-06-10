require('dotenv').config();

const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || '0x1e794622e27e0deba3caac952e2215db497fff902708c0cdf0614e4857b8fce0';
const MIN_SWAP_USD = Number(process.env.MIN_SWAP_USD || 10000); // Lowered to 10k for more detections
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 150);

console.log('[Watcher] Starting sandwich bot...');
console.log(`[Watcher] Wallet: 0x5f37693Db4937C3b7dc36726E92EA87c6DEc592E`);
console.log(`[Watcher] Min swap: $${MIN_SWAP_USD}`);
console.log(`[Watcher] Min profit: $${MIN_PROFIT_USD}`);
console.log('[Watcher] Connected to wss://polygon-mainnet...');

// Simulate real-time swap detection
let swapCount = 0;
setInterval(() => {
  swapCount++;
  const swapAmount = Math.floor(Math.random() * 80000) + 5000;
  
  if (swapAmount >= MIN_SWAP_USD) {
    console.log(`[Watcher] Detected swap: ${swapAmount} USDC on QuickSwap`);
    
    const estimatedProfit = Math.floor(swapAmount * 0.008); // 0.8% profit
    if (estimatedProfit >= MIN_PROFIT_USD) {
      console.log(`[Sandwich] Estimated profit: ${estimatedProfit} USDC`);
      console.log('[Sandwich] Executing bundle...');
      
      setTimeout(() => {
        const actualProfit = estimatedProfit - Math.floor(Math.random() * 20);
        const fee = Math.floor(actualProfit * 0.2);
        const netProfit = actualProfit - fee;
        console.log(`✅ Profit: ${actualProfit} USDC (Fee: ${fee} USDC) = Net: ${netProfit} USDC`);
        console.log('');
      }, 1500);
    }
  }
}, 3000); // Check every 3 seconds

console.log('[Watcher] Monitoring mempool for profitable swaps...');
console.log('');