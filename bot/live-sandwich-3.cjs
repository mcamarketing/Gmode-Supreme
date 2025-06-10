require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

// REAL CONFIGURATION
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || '0x1e794622e27e0deba3caac952e2215db497fff902708c0cdf0614e4857b8fce0';
const RPC_WS = process.env.RPC_WS || 'wss://polygon-mainnet.g.alchemy.com/v2/--DRiUyWVzX5xyaH8pS4qENWg29tWohT';
const MIN_SWAP_USD = Number(process.env.MIN_SWAP_USD || 25000);
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 150);
const GAS_PREMIUM_GWEI = Number(process.env.GAS_PREMIUM_GWEI || 7);

// REAL CONTRACTS
const QUICKSWAP_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
const QUICKSWAP_FACTORY = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

// Initialize provider and wallet
const provider = new ethers.WebSocketProvider(RPC_WS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
let nonce = null;

console.log(`[LIVE] Sandwich Bot Starting...`);
console.log(`[LIVE] Wallet: ${wallet.address}`);
console.log(`[LIVE] Min Swap: $${MIN_SWAP_USD}`);
console.log(`[LIVE] Min Profit: $${MIN_PROFIT_USD}`);

// Router ABI for swap functions
const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

// ERC20 ABI
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const router = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, wallet);

// Get current nonce
async function updateNonce() {
  nonce = await wallet.getNonce('pending');
  return nonce;
}

// Monitor pending transactions
provider.on('pending', async (txHash) => {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to || !tx.data) return;
    
    // Check if transaction is to QuickSwap router
    if (tx.to.toLowerCase() === QUICKSWAP_ROUTER.toLowerCase()) {
      // Decode swap data
      const iface = new ethers.Interface(ROUTER_ABI);
      let decoded;
      
      try {
        decoded = iface.parseTransaction({ data: tx.data });
      } catch (e) {
        return; // Not a swap transaction
      }
      
      // Check if it's a token swap
      if (decoded.name === 'swapExactTokensForTokens' || decoded.name === 'swapExactETHForTokens') {
        const path = decoded.args.path;
        const amountIn = decoded.args.amountIn || tx.value;
        
        // Calculate USD value (assuming path[0] is input token)
        const inputToken = path[0];
        const outputToken = path[path.length - 1];
        
        console.log(`[DETECTED] Swap on QuickSwap`);
        console.log(`  From: ${inputToken}`);
        console.log(`  To: ${outputToken}`);
        console.log(`  Amount: ${ethers.formatEther(amountIn)}`);
        
        // Check if profitable to sandwich
        const profit = await calculateSandwichProfit(path, amountIn, tx);
        
        if (profit.netProfitUSD >= MIN_PROFIT_USD) {
          console.log(`[PROFIT] Estimated profit: $${profit.netProfitUSD}`);
          await executeSandwich(tx, path, profit);
        }
      }
    }
  } catch (error) {
    // Silent fail for individual tx errors
  }
});

// Calculate potential sandwich profit
async function calculateSandwichProfit(path, victimAmountIn, victimTx) {
  try {
    // Get current reserves
    const amounts = await router.getAmountsOut(victimAmountIn, path);
    const victimAmountOut = amounts[amounts.length - 1];
    
    // Calculate optimal sandwich size (simplified)
    const sandwichAmountIn = victimAmountIn / 4n; // 25% of victim size
    
    // Calculate our front-run output
    const frontRunAmounts = await router.getAmountsOut(sandwichAmountIn, path);
    const frontRunAmountOut = frontRunAmounts[frontRunAmounts.length - 1];
    
    // Calculate back-run (reverse path)
    const reversePath = [...path].reverse();
    const backRunAmounts = await router.getAmountsOut(frontRunAmountOut, reversePath);
    const backRunAmountOut = backRunAmounts[backRunAmounts.length - 1];
    
    // Calculate profit
    const grossProfit = backRunAmountOut - sandwichAmountIn;
    const gasPrice = victimTx.gasPrice || ethers.parseUnits('30', 'gwei');
    const totalGas = gasPrice * 400000n; // Estimate 400k gas for both txs
    
    const netProfit = grossProfit - totalGas;
    const netProfitUSD = Number(ethers.formatUnits(netProfit, 6)); // Assuming USDC decimals
    
    return {
      sandwichAmountIn,
      frontRunAmountOut,
      backRunAmountOut,
      grossProfit,
      netProfit,
      netProfitUSD,
      gasPrice
    };
  } catch (error) {
    return { netProfitUSD: 0 };
  }
}

// Execute sandwich attack
async function executeSandwich(victimTx, path, profitCalc) {
  try {
    console.log(`[EXECUTING] Sandwich attack...`);
    
    // Update nonce
    const currentNonce = await updateNonce();
    
    // Prepare front-run transaction
    const frontRunTx = {
      to: QUICKSWAP_ROUTER,
      data: router.interface.encodeFunctionData('swapExactTokensForTokens', [
        profitCalc.sandwichAmountIn,
        0, // Accept any amount of tokens out
        path,
        wallet.address,
        Math.floor(Date.now() / 1000) + 300 // 5 minute deadline
      ]),
      gasLimit: 250000n,
      gasPrice: profitCalc.gasPrice + ethers.parseUnits(String(GAS_PREMIUM_GWEI), 'gwei'),
      nonce: currentNonce
    };
    
    // Prepare back-run transaction
    const reversePath = [...path].reverse();
    const backRunTx = {
      to: QUICKSWAP_ROUTER,
      data: router.interface.encodeFunctionData('swapExactTokensForTokens', [
        profitCalc.frontRunAmountOut,
        0,
        reversePath,
        wallet.address,
        Math.floor(Date.now() / 1000) + 300
      ]),
      gasLimit: 250000n,
      gasPrice: victimTx.gasPrice, // Same as victim
      nonce: currentNonce + 1
    };
    
    // Send transactions
    console.log(`[SENDING] Front-run transaction...`);
    const frontRunReceipt = await wallet.sendTransaction(frontRunTx);
    
    console.log(`[SENDING] Back-run transaction...`);
    const backRunReceipt = await wallet.sendTransaction(backRunTx);
    
    // Wait for confirmations
    console.log(`[WAITING] For confirmations...`);
    await frontRunReceipt.wait();
    await backRunReceipt.wait();
    
    console.log(`✅ [SUCCESS] Sandwich complete!`);
    console.log(`   Front-run: ${frontRunReceipt.hash}`);
    console.log(`   Back-run: ${backRunReceipt.hash}`);
    console.log(`   Net Profit: $${profitCalc.netProfitUSD}`);
    
  } catch (error) {
    console.error(`❌ [FAILED] Sandwich execution:`, error.message);
  }
}

// Initialize token approvals
async function initializeApprovals() {
  console.log(`[INIT] Setting up token approvals...`);
  
  const tokens = [USDC_ADDRESS, WMATIC_ADDRESS];
  for (const tokenAddress of tokens) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, QUICKSWAP_ROUTER);
    
    if (allowance < ethers.MaxUint256 / 2n) {
      console.log(`[APPROVE] Approving ${tokenAddress}...`);
      const tx = await token.approve(QUICKSWAP_ROUTER, ethers.MaxUint256);
      await tx.wait();
      console.log(`[APPROVED] ${tokenAddress}`);
    }
  }
}

// Start bot
async function start() {
  try {
    // Check wallet balance first
    const balance = await provider.getBalance(wallet.address);
    console.log(`[WALLET] MATIC Balance: ${ethers.formatEther(balance)} MATIC`);
    
    if (balance === 0n) {
      console.warn(`⚠️  [WARNING] Wallet has 0 MATIC. Bot will monitor but cannot execute trades.`);
      console.warn(`⚠️  [WARNING] Please fund wallet: ${wallet.address}`);
      console.warn(`⚠️  [WARNING] Minimum recommended: 10 MATIC for gas`);
      console.warn(`⚠️  [WARNING] Skipping token approvals until wallet is funded`);
    } else {
      await initializeApprovals();
    }
    
    await updateNonce();
    console.log(`[READY] Monitoring for profitable swaps...`);
    console.log(`[INFO] Listening to all QuickSwap transactions...`);
  } catch (error) {
    console.error(`[ERROR] Startup failed:`, error);
    process.exit(1);
  }
}

// Start the bot
start();