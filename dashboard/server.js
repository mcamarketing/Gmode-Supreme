const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// Serve static files from React build
app.use(express.static(path.join(__dirname, '../dist')));

// Proxy API requests to backend
app.use('/api', createProxyMiddleware({
  target: `http://localhost:${process.env.BACKEND_PORT || 3001}`,
  changeOrigin: true,
  ws: true
}));

// Proxy WebSocket connections
app.use('/socket.io', createProxyMiddleware({
  target: `http://localhost:${process.env.BACKEND_PORT || 3001}`,
  changeOrigin: true,
  ws: true
}));

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard server running on port ${PORT}`);
  console.log(`Proxying API requests to backend on port ${process.env.BACKEND_PORT || 3001}`);
});