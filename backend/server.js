const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const winston = require('winston');
const path = require('path');
require('dotenv').config();

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/backend-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/backend-combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Express app setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../bot/public')));

// In-memory store for real-time data
const store = {
  opportunities: [],
  metrics: {
    totalProfit: 0,
    totalTransactions: 0,
    successRate: 0,
    activePositions: []
  },
  systemStatus: {
    isRunning: true,
    lastUpdate: Date.now(),
    connectedBots: 0
  }
};

// WebSocket connections
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  // Send initial data
  socket.emit('initial-data', {
    opportunities: store.opportunities.slice(-10),
    metrics: store.metrics,
    systemStatus: store.systemStatus
  });
  
  // Handle client requests
  socket.on('request-update', () => {
    socket.emit('data-update', {
      opportunities: store.opportunities.slice(-10),
      metrics: store.metrics,
      systemStatus: store.systemStatus
    });
  });
  
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    status: 'operational',
    uptime: process.uptime(),
    timestamp: Date.now(),
    systemStatus: store.systemStatus
  });
});

app.get('/api/opportunities', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const opportunities = store.opportunities.slice(-limit);
  
  res.json({
    opportunities,
    count: opportunities.length,
    timestamp: Date.now()
  });
});

app.post('/api/execute', async (req, res) => {
  const { opportunityId, userAddress } = req.body;
  
  if (!opportunityId || !userAddress) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  try {
    // Simulate execution (in production, this would trigger actual execution)
    logger.info(`Executing opportunity ${opportunityId} for user ${userAddress}`);
    
    // Update metrics
    store.metrics.totalTransactions++;
    
    // Broadcast update to all connected clients
    io.emit('execution-update', {
      opportunityId,
      userAddress,
      status: 'executed',
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      transactionHash: '0x' + Math.random().toString(16).substr(2, 64),
      message: 'Trade executed successfully'
    });
  } catch (error) {
    logger.error('Execution error:', error);
    res.status(500).json({ error: 'Execution failed' });
  }
});

app.get('/api/logs', (req, res) => {
  const { userAddress, limit = 20 } = req.query;
  
  // In production, this would query a database
  const logs = [];
  
  res.json({
    logs,
    count: logs.length,
    userAddress,
    timestamp: Date.now()
  });
});

app.get('/api/stats/:userAddress', (req, res) => {
  const { userAddress } = req.params;
  
  // In production, this would query user-specific data
  const stats = {
    totalProfit: Math.random() * 1000,
    totalTrades: Math.floor(Math.random() * 100),
    successRate: 0.85,
    averageProfit: Math.random() * 10,
    lastTrade: Date.now() - Math.random() * 86400000
  };
  
  res.json({
    userAddress,
    stats,
    timestamp: Date.now()
  });
});

// Simulated data updates (in production, this would come from the bots)
function simulateDataUpdates() {
  setInterval(() => {
    // Generate fake opportunity
    const opportunity = {
      id: Math.random().toString(36).substr(2, 9),
      type: ['arbitrage', 'sandwich', 'liquidation'][Math.floor(Math.random() * 3)],
      profit: Math.random() * 100,
      confidence: 0.7 + Math.random() * 0.3,
      gasEstimate: 100000 + Math.floor(Math.random() * 200000),
      timestamp: Date.now()
    };
    
    // Add to store
    store.opportunities.push(opportunity);
    if (store.opportunities.length > 100) {
      store.opportunities.shift();
    }
    
    // Update metrics
    store.metrics.totalProfit += opportunity.profit;
    store.systemStatus.lastUpdate = Date.now();
    
    // Broadcast to connected clients
    io.emit('new-opportunity', opportunity);
  }, 5000);
  
  // Update system status
  setInterval(() => {
    store.systemStatus.connectedBots = Math.floor(Math.random() * 5) + 1;
    io.emit('system-update', store.systemStatus);
  }, 10000);
}

// Error handling
app.use((err, req, res, next) => {
  logger.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || process.env.BACKEND_PORT || 3001;

server.listen(PORT, () => {
  logger.info(`Backend server running on port ${PORT}`);
  logger.info(`WebSocket server ready for connections`);
  
  // Start simulated updates
  simulateDataUpdates();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});