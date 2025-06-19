#!/bin/bash

echo "🚀 Starting Godmode Supreme MEV Bot System..."
echo "==========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found!${NC}"
    echo "Please create a .env file with your configuration"
    echo "Run: cp .env.example .env"
    exit 1
fi

# Load environment variables
export $(grep -v '^#' .env | xargs)

# Create necessary directories
echo -e "${YELLOW}📁 Creating directories...${NC}"
mkdir -p logs
mkdir -p cache
mkdir -p artifacts

# Validate environment
echo -e "${YELLOW}🔍 Validating environment...${NC}"
node bot/scripts/validate-env.js
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Environment validation failed!${NC}"
    exit 1
fi

# Check dependencies
echo -e "${YELLOW}📦 Checking dependencies...${NC}"
node bot/scripts/check-dependencies.js
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Dependency check failed!${NC}"
    exit 1
fi

# Start backend server
echo -e "${YELLOW}🖥️  Starting backend server...${NC}"
cd backend
npm start &
BACKEND_PID=$!
cd ..
sleep 3

# Check if backend is running
curl -s http://localhost:${BACKEND_PORT:-3001}/api/status > /dev/null
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Backend server is running on port ${BACKEND_PORT:-3001}${NC}"
else
    echo -e "${RED}❌ Backend server failed to start${NC}"
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi

# Build frontend if needed
if [ ! -d "dist" ]; then
    echo -e "${YELLOW}🏗️  Building frontend...${NC}"
    npm run build
fi

# Start dashboard server
echo -e "${YELLOW}📊 Starting dashboard server...${NC}"
node dashboard/server.js &
DASHBOARD_PID=$!
sleep 2

# Check if dashboard is running
curl -s http://localhost:${DASHBOARD_PORT:-3000} > /dev/null
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Dashboard server is running on port ${DASHBOARD_PORT:-3000}${NC}"
else
    echo -e "${YELLOW}⚠️  Dashboard server may not be running${NC}"
fi

# Start PM2 processes
echo -e "${YELLOW}🤖 Starting bot processes with PM2...${NC}"

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Installing PM2...${NC}"
    npm install -g pm2
fi

# Start ecosystem
pm2 start ecosystem.config.cjs --env production

# Show PM2 status
pm2 status

echo ""
echo -e "${GREEN}🎉 Godmode Supreme is running!${NC}"
echo "==========================================="
echo -e "📊 Dashboard: ${GREEN}http://localhost:${DASHBOARD_PORT:-3000}${NC}"
echo -e "🖥️  Backend API: ${GREEN}http://localhost:${BACKEND_PORT:-3001}/api/status${NC}"
echo -e "📝 Logs: ${GREEN}pm2 logs${NC}"
echo -e "📈 Monitor: ${GREEN}pm2 monit${NC}"
echo ""
echo -e "${YELLOW}To stop all services:${NC} pm2 stop all && kill $BACKEND_PID $DASHBOARD_PID"
echo ""

# Keep script running
echo "Press Ctrl+C to stop all services..."

# Trap Ctrl+C
trap cleanup INT

cleanup() {
    echo ""
    echo -e "${YELLOW}Stopping all services...${NC}"
    pm2 stop all
    kill $BACKEND_PID 2>/dev/null
    kill $DASHBOARD_PID 2>/dev/null
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

# Keep script running
while true; do
    sleep 1
done