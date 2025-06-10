require('dotenv').config();

console.log('Validating environment variables...');

const requiredVars = [
  'PRIVATE_KEY',
  'RPC_URL',
  'MIN_SWAP_USD',
  'MIN_PROFIT_USD',
  'GAS_PREMIUM_GWEI',
  'PLATFORM_WALLET'
];

let hasError = false;

requiredVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    hasError = true;
  }
});

if (hasError) {
  console.error('Environment validation failed!');
  process.exit(1);
} else {
  console.log('Environment validation passed!');
  process.exit(0);
}