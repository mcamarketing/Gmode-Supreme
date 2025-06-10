require('dotenv').config();
const { ethers } = require('ethers');

// REAL CONTRACTS & ABIS
const QUICKSWAP_ROUTER = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
const QUICKSWAP_FACTORY = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const FLASHLOAN_ABI = [
  'function executeOperation(address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params) external returns (bool)',
  'function ADDRESSES_PROVIDER() external view returns (address)',
  'function POOL() external view returns (address)'
];

// CONFIGURATION
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || '0x1e794622e27e0deba3caac952e2215db497fff902708c0cdf0614e4857b8fce0';
const RPC_HTTP = 'https://polygon-mainnet.g.alchemy.com/v2/--DRiUyWVzX5xyaH8pS4qENWg29tWohT';
const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD || 150);
const GAS_PREMIUM = Number(process.env.GAS_PREMIUM_GWEI || 7);

// INITIALIZE PROVIDERS & CONTRACTS
let provider;
let wallet;
let router;
let factory;

let consecutiveFailures = 0;
let nonce = null;

async function updateNonce() {
  nonce = await wallet.getNonce('pending');
  return nonce;
}

async function initializeProvider() {
  try {
    // Validate private key
    if (!PRIVATE_KEY || PRIVATE_KEY.length !== 66 || !PRIVATE_KEY.startsWith('0x')) {
      throw new Error('Invalid private key format. Must be 0x-prefixed 64-character hex string.');
    }

    console.log('[INIT] Connecting to Polygon mainnet...');
    provider = new ethers.JsonRpcProvider(RPC_HTTP);
    
    console.log('[INIT] Initializing wallet...');
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`[INIT] Wallet address: ${wallet.address}`);
    
    console.log('[INIT] Setting up contracts...');
    router = new ethers.Contract(QUICKSWAP_ROUTER, ROUTER_ABI, wallet);
    factory = new ethers.Contract(QUICKSWAP_FACTORY, FACTORY_ABI, wallet);
    
    // Test provider connection
    const network = await provider.getNetwork();
    console.log(`[INIT] Connected to ${network.name} (Chain ID: ${network.chainId})`);
    
    return true;
  } catch (error) {
    console.error('[INIT ERROR]', error.message);
    if (error.message.includes('private key')) {
      console.error('[HELP] Check your .env file and ensure PRIVATE_KEY_1 is set correctly');
    }
    return false;
  }
}

async function calculateRealProfit(path, amountIn, victimTx) {
  try {
    // Get pair contract and reserves
    const pair = await factory.getPair(path[0], path[1]);
    const pairContract = new ethers.Contract(pair, FACTORY_ABI, provider);
    const { reserve0, reserve1 } = await pairContract.getReserves();

    // Calculate optimal front-run amount (25% of victim)
    const frontRunIn = amountIn / 4n;
    
    // Calculate all outputs with real reserves
    const frontRunOut = await router.getAmountsOut(frontRunIn, path);
    const victimOut = await router.getAmountsOut(amountIn, path);
    const backRunIn = frontRunOut[frontRunOut.length - 1];
    const backRunOut = await router.getAmountsOut(backRunIn, path.reverse());

    // Calculate real profit after gas
    const grossProfit = backRunOut[backRunOut.length - 1] - frontRunIn;
    const gasPrice = victimTx.gasPrice || (await provider.getFeeData()).gasPrice;
    const gasCost = gasPrice * 500000n; // Estimate 500k gas total

    const netProfit = grossProfit - gasCost;
    const netProfitUSD = Number(ethers.formatUnits(netProfit, 6)); // USDC decimals

    return {
      frontRunIn,
      frontRunOut: frontRunOut[frontRunOut.length - 1],
      backRunIn,
      backRunOut: backRunOut[backRunOut.length - 1],
      netProfitUSD,
      gasPrice
    };
  } catch (error) {
    console.error('[ERROR] Profit calculation failed:', error.message);
    return { netProfitUSD: 0 };
  }
}

async function executeSandwich(victimTx, path, profit) {
  try {
    console.log(`[EXEC] Building sandwich bundle...`);
    const currentNonce = await updateNonce();

    // Prepare flash loan parameters
    const assets = [path[0]];
    const amounts = [profit.frontRunIn];
    const modes = [0]; // 0 = no debt, 1 = stable, 2 = variable
    
    // Encode sandwich parameters
    const abiCoder = new ethers.AbiCoder();
    const params = abiCoder.encode(
      ['address[]', 'uint256[]', 'uint256[]', 'bytes'],
      [
        [QUICKSWAP_ROUTER, victimTx.to, QUICKSWAP_ROUTER],
        [profit.frontRunIn, 0, profit.backRunIn],
        [0, 0, 0],
        '0x'
      ]
    );

    // Build flash loan transaction
    const flashLoanTx = {
      to: AAVE_POOL,
      data: abiCoder.encode(
        ['address[]', 'uint256[]', 'uint256[]', 'address', 'bytes'],
        [assets, amounts, modes, wallet.address, params]
      ),
      gasLimit: 500000n,
      maxFeePerGas: profit.gasPrice + ethers.parseUnits(String(GAS_PREMIUM), 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(String(GAS_PREMIUM), 'gwei'),
      nonce: currentNonce
    };

    // Send transaction
    console.log(`[EXEC] Sending flash loan transaction...`);
    const tx = await wallet.sendTransaction(flashLoanTx);
    
    // Wait for confirmation
    console.log(`[EXEC] Waiting for confirmation...`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log(`✅ Sandwich successful!`);
      console.log(`   TX Hash: ${receipt.transactionHash}`);
      console.log(`   Gas Used: ${receipt.gasUsed}`);
      console.log(`   Net Profit: $${profit.netProfitUSD}`);
      
      consecutiveFailures = 0;
      return true;
    } else {
      throw new Error('Transaction reverted');
    }

  } catch (error) {
    console.error(`❌ [FAILED] Sandwich execution:`, error.message);
    consecutiveFailures++;
    
    if (consecutiveFailures >= 3) {
      console.error(`🚨 [EMERGENCY] 3 consecutive failures - shutting down`);
      process.exit(1);
    }
    return false;
  }
}

function startMonitoring() {
  // Poll for new blocks instead of WebSocket
  provider.on('block', async (blockNumber) => {
    try {
      const block = await provider.getBlock(blockNumber, true);
      if (!block || !block.transactions) return;

      console.log(`[BLOCK] #${blockNumber} - ${block.transactions.length} transactions`);

      for (const tx of block.transactions) {
        if (!tx.to || !tx.data) continue;

        // Check if transaction is to QuickSwap router
        if (tx.to.toLowerCase() === QUICKSWAP_ROUTER.toLowerCase()) {
          const iface = new ethers.Interface(ROUTER_ABI);
          let decoded;
          
          try {
            decoded = iface.parseTransaction({ data: tx.data });
          } catch (e) {
            continue; // Not a swap transaction
          }

          // Check if it's a token swap
          if (decoded.name.includes('swap')) {
            const path = decoded.args.path;
            const amountIn = decoded.args.amountIn || tx.value;

            console.log(`[DETECTED] Swap on QuickSwap`);
            console.log(`  From: ${path[0]}`);
            console.log(`  To: ${path[path.length - 1]}`);
            console.log(`  Amount: ${ethers.formatUnits(amountIn, path[0] === USDC ? 6 : 18)}`);

            // Calculate real profit
            const profit = await calculateRealProfit(path, amountIn, tx);

            if (profit.netProfitUSD >= MIN_PROFIT_USD) {
              console.log(`[PROFIT] Estimated profit: $${profit.netProfitUSD}`);
              await executeSandwich(tx, path, profit);
            }
          }
        }
      }
    } catch (error) {
      console.error('[BLOCK ERROR]', error.message);
    }
  });
}

async function start() {
  try {
    console.log(`[STARTING] Initializing sandwich bot...`);
    
    if (!await initializeProvider()) {
      throw new Error('Failed to initialize provider');
    }
    
    const balance = await provider.getBalance(wallet.address);
    console.log(`[WALLET] MATIC Balance: ${ethers.formatEther(balance)} MATIC`);
    
    if (balance === 0n) {
      console.error(`[ERROR] Wallet has no MATIC. Fund wallet: ${wallet.address}`);
      process.exit(1);
    }

    await updateNonce();
    console.log(`[READY] Monitoring QuickSwap for profitable swaps...`);
    console.log(`[CONFIG] Min Profit: $${MIN_PROFIT_USD}`);
    console.log(`[CONFIG] Gas Premium: ${GAS_PREMIUM} gwei`);
    
    startMonitoring();
    
  } catch (error) {
    console.error(`[ERROR] Startup failed:`, error);
    process.exit(1);
  }
}

start();