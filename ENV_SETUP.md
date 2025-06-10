# Environment Setup Guide

## Required Environment Variables

### Network Configuration
- `RPC_URL`: WebSocket URL for the Polygon network (must start with ws:// or wss://)
- `FALLBACK_RPC_URLS`: Comma-separated list of fallback RPC URLs
- `NETWORK`: Network name (e.g., 'polygon')

### Bot Configuration
- `BOT_PRIVATE_KEY`: 64-character hexadecimal private key (with or without 0x prefix)
- `FLASH_ENGINE_ADDRESS`: Valid Ethereum address of the Flash Engine contract
- `MIN_SWAP_USD`: Minimum swap size in USD (default: 25)
- `MIN_PROFIT_USD`: Minimum profit threshold in USD (default: 0.05)
- `GAS_PREMIUM_GWEI`: Gas premium in GWEI (default: 2.0)
- `MAX_GAS_PRICE`: Maximum gas price in GWEI (default: 1000)
- `GAS_LIMIT`: Gas limit for transactions (default: 600000)
- `MAX_SLIPPAGE`: Maximum allowed slippage percentage (default: 2.0)
- `MIN_LIQUIDITY`: Minimum liquidity requirement in USD (default: 50000)

### Wallet Management
- `PLATFORM_WALLET`: Valid Ethereum address for platform fees
- `COLD_WALLET_ADDRESS`: Valid Ethereum address for cold storage
- `WALLET_ROTATION_TIME`: Time between wallet rotations in milliseconds (default: 1800000)
- `WALLET_ROTATION_TRADES`: Number of trades before wallet rotation (default: 50)

### System Configuration
- `SCAN_INTERVAL`: Mempool scan interval in milliseconds (default: 1000)
- `SYNC_INTERVAL`: Blockchain sync interval in milliseconds (default: 500)
- `MAX_ANOMALIES`: Maximum number of anomalies before circuit breaker (default: 5)
- `PROFIT_THRESHOLD`: Profit threshold for circuit breaker (default: 0.05)
- `AUTO_WITHDRAW_THRESHOLD`: Threshold for automatic withdrawals (default: 0.1)

### Connection Settings
- `WS_RECONNECT_INTERVAL`: WebSocket reconnect interval in milliseconds (default: 5000)
- `MAX_RECONNECT_ATTEMPTS`: Maximum number of reconnection attempts (default: 10)

## Setup Instructions

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in the required variables in `.env`:
   ```
   BOT_PRIVATE_KEY=your_private_key_here
   RPC_URL=your_rpc_url_here
   FLASH_ENGINE_ADDRESS=your_flash_engine_address_here
   PLATFORM_WALLET=your_platform_wallet_address_here
   COLD_WALLET_ADDRESS=your_cold_wallet_address_here
   ```

3. Validate the environment:
   ```bash
   node bot/scripts/validate-env.js
   ```

4. Start the bot:
   ```bash
   pm2 start ecosystem.config.cjs --env production
   ```

## Security Best Practices

1. Never commit `.env` file to version control
2. Use a dedicated wallet for the bot with limited funds
3. Regularly rotate private keys
4. Monitor wallet balances and transactions
5. Set up alerts for unusual activity

## Troubleshooting

### Common Issues

1. **BOT_PRIVATE_KEY is required**
   - Ensure the private key is set in `.env`
   - Check for proper formatting (64 hex characters)
   - Verify no extra spaces or quotes

2. **Invalid RPC URL**
   - Must be a WebSocket URL (ws:// or wss://)
   - Check network connectivity
   - Verify RPC endpoint is operational

3. **Invalid Address Format**
   - All Ethereum addresses must be 42 characters
   - Must start with 0x
   - Check for typos

### Validation Script

Run the validation script to check your environment:
```bash
node bot/scripts/validate-env.js
```

The script will:
- Verify all required variables are present
- Validate private key format
- Check RPC URL format
- Validate Ethereum addresses
- Provide detailed error messages

## Monitoring

1. Check process status:
   ```bash
   pm2 status
   ```

2. View logs:
   ```bash
   pm2 logs sandwich-1
   ```

3. Monitor system health:
   ```bash
   pm2 monit
   ```

## Support

For issues or questions:
1. Check the logs for detailed error messages
2. Verify environment variables using the validation script
3. Ensure all required variables are properly set
4. Check network connectivity and RPC endpoint status 