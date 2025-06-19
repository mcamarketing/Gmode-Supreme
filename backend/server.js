import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import corsMiddleware from './middleware/cors.js';
import rateLimiter from './middleware/rateLimiter.js';
import { logger } from './utils/logger.js';
import { ArbitrageOrchestrator } from './services/ArbitrageOrchestrator.js';
import { MempoolListener } from './services/MempoolListener.js';
import { ProfitEngine } from './services/ProfitEngine.js';
import { TransactionEngine } from './services/TransactionEngine.js';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(corsMiddleware);
app.use(rateLimiter);

// Services
let arbitrageOrchestrator;
let mempoolListener;
let profitEngine;
let transactionEngine;

// WebSocket connections
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.info('New WebSocket client connected');
  
  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket client disconnected');
  });
});

// Broadcast to all WebSocket clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    services: {
      arbitrage: arbitrageOrchestrator?.isRunning() || false,
      mempool: mempoolListener?.isConnected() || false,
      profit: profitEngine?.isActive() || false,
      transaction: transactionEngine?.isReady() || false
    },
    network: process.env.NETWORK || 'polygon',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/opportunities', async (req, res) => {
  try {
    const opportunities = await arbitrageOrchestrator.getActiveOpportunities();
    res.json({
      success: true,
      count: opportunities.length,
      opportunities: opportunities.map(opp => ({
        id: opp.id,
        type: opp.type,
        profitUSD: opp.profitUSD,
        path: opp.path,
        gasEstimate: opp.gasEstimate,
        timestamp: opp.timestamp
      }))
    });
  } catch (error) {
    logger.error('Error fetching opportunities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/execute', async (req, res) => {
  try {
    const { opportunityId, userAddress } = req.body;
    
    if (!opportunityId || !userAddress) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing opportunityId or userAddress' 
      });
    }

    const result = await transactionEngine.executeOpportunity(
      opportunityId, 
      userAddress
    );
    
    broadcast({
      type: 'execution',
      opportunityId,
      userAddress,
      result
    });

    res.json({
      success: true,
      transactionHash: result.hash,
      profitUSD: result.profitUSD,
      gasUsed: result.gasUsed
    });
  } catch (error) {
    logger.error('Error executing opportunity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const { userAddress, limit = 50 } = req.query;
    const logs = await profitEngine.getUserLogs(userAddress, parseInt(limit));
    
    res.json({
      success: true,
      logs
    });
  } catch (error) {
    logger.error('Error fetching logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/stats/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const stats = await profitEngine.getUserStats(userAddress);
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Error fetching user stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize services
async function initializeServices() {
  try {
    logger.info('Initializing services...');
    
    // Initialize core services
    arbitrageOrchestrator = new ArbitrageOrchestrator();
    mempoolListener = new MempoolListener();
    profitEngine = new ProfitEngine();
    transactionEngine = new TransactionEngine();

    // Set up event listeners
    arbitrageOrchestrator.on('opportunity', (opportunity) => {
      broadcast({
        type: 'opportunity',
        data: opportunity
      });
    });

    mempoolListener.on('transaction', (tx) => {
      broadcast({
        type: 'mempool',
        data: {
          hash: tx.hash,
          value: tx.value,
          gasPrice: tx.gasPrice
        }
      });
    });

    // Start services
    await arbitrageOrchestrator.start();
    await mempoolListener.connect();
    await profitEngine.initialize();
    await transactionEngine.initialize();

    logger.info('All services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Start server
server.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  await initializeServices();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  
  if (arbitrageOrchestrator) await arbitrageOrchestrator.stop();
  if (mempoolListener) await mempoolListener.disconnect();
  if (profitEngine) await profitEngine.shutdown();
  if (transactionEngine) await transactionEngine.shutdown();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

export default app;