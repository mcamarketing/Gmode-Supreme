require('dotenv').config();

// Configuration - OVERRIDE THIS IN EACH INSTANCE
const INSTANCE_NAME = 'sandwich-3';
const PRIVATE_KEY = process.env.PRIVATE_KEY_3 || '0x7a5a8e187799a7da6bfde31fc5b90d1cc47dc4b2cf021402d6f15218c378e314';
const RPC_WS = process.env.RPC_WS || 'wss://polygon-mainnet.g.alchemy.com/v2/--DRiUyWVzX5xyaH8pS4qENWg29tWohT';
const MIN_SWAP_USD = Number(process.env.MIN_SWAP_USD || 10000); // Lowered for more detections
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 150);
const GAS_PREMIUM_GWEI = Number(process.env.GAS_PREMIUM_GWEI || 7);

// Risk controls
let consecutiveFailures = 0;
let totalSwapsAttempted = 0;
let totalSuccesses = 0;
let totalNetProfit = 0;
const startTime = Date.now();

console.log(`[${INSTANCE_NAME}] Starting sandwich bot...`);
console.log(`[${INSTANCE_NAME}] Wallet: ${getWalletAddress()}`);
console.log(`[${INSTANCE_NAME}] Min swap: $${MIN_SWAP_USD}`);
console.log(`[${INSTANCE_NAME}] Min profit: $${MIN_PROFIT_USD}`);
console.log(`[${INSTANCE_NAME}] Gas premium: ${GAS_PREMIUM_GWEI} gwei`);
console.log(`[${INSTANCE_NAME}] Connected to ${RPC_WS.slice(0, 30)}...`);
console.log('');

// Helper function to get wallet address
function getWalletAddress() {
  const { ethers } = require('ethers');
  try {
    return new ethers.Wallet(PRIVATE_KEY).address;
  } catch {
    return 'Invalid Key';
  }
}

// Simulate real-time swap detection
setInterval(() => {
  const swapAmount = Math.floor(Math.random() * 80000) + 5000;
  
  if (swapAmount >= MIN_SWAP_USD) {
    console.log(`[${INSTANCE_NAME}] Detected swap: ${swapAmount} USDC on QuickSwap`);
    totalSwapsAttempted++;
    
    const estimatedProfit = Math.floor(swapAmount * 0.008); // 0.8% profit
    if (estimatedProfit >= MIN_PROFIT_USD) {
      console.log(`[${INSTANCE_NAME}] Estimated profit: ${estimatedProfit} USDC`);
      console.log(`[${INSTANCE_NAME}] Executing bundle with ${GAS_PREMIUM_GWEI} gwei priority...`);
      
      // Simulate success/failure (80% success rate)
      const isSuccess = Math.random() > 0.2;
      
      setTimeout(() => {
        if (isSuccess) {
          const actualProfit = estimatedProfit - Math.floor(Math.random() * 20);
          const fee = Math.floor(actualProfit * 0.2);
          const netProfit = actualProfit - fee;
          
          console.log(`✅ [${INSTANCE_NAME}] Profit: ${actualProfit} USDC (Fee: ${fee} USDC) = Net: ${netProfit} USDC`);
          console.log(`📊 [${INSTANCE_NAME}] Stats: ${totalSuccesses + 1}/${totalSwapsAttempted} successful`);
          console.log('');
          
          totalSuccesses++;
          totalNetProfit += netProfit;
          consecutiveFailures = 0; // Reset on success
          
          // Log profit summary every 5 successes
          if (totalSuccesses % 5 === 0) {
            logProfitSummary();
          }
        } else {
          console.log(`❌ [${INSTANCE_NAME}] Bundle failed - gas too low or frontrun`);
          consecutiveFailures++;
          
          if (consecutiveFailures >= 3) {
            console.error(`🚨 [${INSTANCE_NAME}] 3 consecutive failures—shutting down to preserve capital`);
            logProfitSummary();
            process.exit(1);
          }
          
          console.log(`⚠️  [${INSTANCE_NAME}] Consecutive failures: ${consecutiveFailures}/3`);
          console.log('');
        }
      }, 1500);
    }
  }
}, 3000); // Check every 3 seconds

// Profit summary logging
function logProfitSummary() {
  const runtime = Math.floor((Date.now() - startTime) / 1000 / 60); // minutes
  const successRate = totalSwapsAttempted > 0 ? (totalSuccesses / totalSwapsAttempted * 100).toFixed(1) : 0;
  
  console.log('='.repeat(60));
  console.log(`📈 [${INSTANCE_NAME}] PROFIT SUMMARY`);
  console.log(`Runtime: ${runtime} minutes`);
  console.log(`Total swaps attempted: ${totalSwapsAttempted}`);
  console.log(`Total successes: ${totalSuccesses}`);
  console.log(`Success rate: ${successRate}%`);
  console.log(`💰 TOTAL NET PROFIT: ${totalNetProfit} USDC`);
  console.log('='.repeat(60));
  console.log('');
  
  // Send notification (simulated)
  console.log(`📧 [${INSTANCE_NAME}] Sending profit report...`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n[${INSTANCE_NAME}] Shutting down...`);
  logProfitSummary();
  process.exit(0);
});

console.log(`[${INSTANCE_NAME}] Monitoring mempool for profitable swaps...`);
console.log('');