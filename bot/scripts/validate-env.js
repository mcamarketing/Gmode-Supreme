#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('Validating environment configuration...\n');

// Required environment variables
const requiredVars = [
  { name: 'BOT_PRIVATE_KEY', type: 'privateKey', description: 'Bot wallet private key' },
  { name: 'RPC_URL', type: 'websocket', description: 'WebSocket RPC URL' },
  { name: 'FLASH_ENGINE_ADDRESS', type: 'address', description: 'Flash Engine contract address' },
  { name: 'PLATFORM_WALLET', type: 'address', description: 'Platform fee wallet address' },
  { name: 'COLD_WALLET_ADDRESS', type: 'address', description: 'Cold storage wallet address' }
];

// Optional but recommended variables
const optionalVars = [
  { name: 'MIN_SWAP_USD', default: '25', description: 'Minimum swap size in USD' },
  { name: 'MIN_PROFIT_USD', default: '0.05', description: 'Minimum profit threshold in USD' },
  { name: 'GAS_PREMIUM_GWEI', default: '2.0', description: 'Gas premium in GWEI' },
  { name: 'MAX_GAS_PRICE', default: '1000', description: 'Maximum gas price in GWEI' },
  { name: 'SCAN_INTERVAL', default: '1000', description: 'Mempool scan interval in ms' },
  { name: 'NOTIFICATION_EMAIL', default: '', description: 'Email for notifications' }
];

let hasErrors = false;
const warnings = [];

// Validation functions
function validatePrivateKey(value) {
  if (!value) return 'Private key is required';
  
  // Remove 0x prefix if present
  const cleanKey = value.startsWith('0x') ? value.slice(2) : value;
  
  if (!/^[a-fA-F0-9]{64}$/.test(cleanKey)) {
    return 'Private key must be 64 hexadecimal characters';
  }
  
  return null;
}

function validateWebsocketUrl(value) {
  if (!value) return 'WebSocket URL is required';
  
  if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
    return 'RPC URL must be a WebSocket URL (ws:// or wss://)';
  }
  
  return null;
}

function validateAddress(value) {
  if (!value) return 'Address is required';
  
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return 'Invalid Ethereum address format';
  }
  
  return null;
}

function validateNumeric(value, min, max) {
  const num = parseFloat(value);
  
  if (isNaN(num)) {
    return 'Must be a valid number';
  }
  
  if (min !== undefined && num < min) {
    return `Must be at least ${min}`;
  }
  
  if (max !== undefined && num > max) {
    return `Must be at most ${max}`;
  }
  
  return null;
}

// Check required variables
console.log('Checking required variables:');
console.log('=' .repeat(50));

for (const varConfig of requiredVars) {
  const value = process.env[varConfig.name];
  let error = null;
  
  switch (varConfig.type) {
    case 'privateKey':
      error = validatePrivateKey(value);
      break;
    case 'websocket':
      error = validateWebsocketUrl(value);
      break;
    case 'address':
      error = validateAddress(value);
      break;
    default:
      error = !value ? `${varConfig.name} is required` : null;
  }
  
  if (error) {
    console.log(`❌ ${varConfig.name}: ${error}`);
    console.log(`   Description: ${varConfig.description}`);
    hasErrors = true;
  } else {
    console.log(`✅ ${varConfig.name}: Valid`);
  }
}

console.log('\n');

// Check optional variables
console.log('Checking optional variables:');
console.log('=' .repeat(50));

for (const varConfig of optionalVars) {
  const value = process.env[varConfig.name];
  
  if (!value && varConfig.default) {
    console.log(`⚠️  ${varConfig.name}: Not set (using default: ${varConfig.default})`);
    warnings.push(`${varConfig.name} not set, using default value: ${varConfig.default}`);
  } else if (value) {
    console.log(`✅ ${varConfig.name}: ${value}`);
  } else {
    console.log(`ℹ️  ${varConfig.name}: Not set`);
  }
}

// Additional checks
console.log('\n');
console.log('Additional checks:');
console.log('=' .repeat(50));

// Check if .env file exists
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.log('⚠️  No .env file found in project root');
  warnings.push('No .env file found. Environment variables must be set elsewhere.');
} else {
  console.log('✅ .env file found');
}

// Check gas price settings
const maxGasPrice = parseFloat(process.env.MAX_GAS_PRICE || '1000');
const gasPremium = parseFloat(process.env.GAS_PREMIUM_GWEI || '2.0');

if (gasPremium > maxGasPrice * 0.1) {
  console.log('⚠️  Gas premium is more than 10% of max gas price');
  warnings.push('High gas premium relative to max gas price may limit execution opportunities');
} else {
  console.log('✅ Gas settings are reasonable');
}

// Check profit thresholds
const minProfit = parseFloat(process.env.MIN_PROFIT_USD || '0.05');
const minSwap = parseFloat(process.env.MIN_SWAP_USD || '25');

if (minProfit < 0.01) {
  console.log('⚠️  Very low profit threshold may result in unprofitable trades after gas');
  warnings.push('Consider increasing MIN_PROFIT_USD to ensure profitability after gas costs');
} else {
  console.log('✅ Profit threshold is reasonable');
}

// Summary
console.log('\n');
console.log('=' .repeat(50));
console.log('VALIDATION SUMMARY');
console.log('=' .repeat(50));

if (hasErrors) {
  console.log('❌ Validation FAILED');
  console.log('\nPlease fix the errors above before starting the bot.');
  console.log('Refer to ENV_SETUP.md for detailed configuration instructions.');
  process.exit(1);
} else {
  console.log('✅ All required variables are valid');
  
  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  
  console.log('\n✅ Environment validation passed!');
  process.exit(0);
}