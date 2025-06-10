#!/bin/bash

echo "🚀 Launching Godmode Supreme Sandwich Bot Fleet..."
echo "================================================"

# Kill any existing node processes
pkill -f "node sandwich-" || true

# Launch each bot in background
echo "Starting sandwich-1..."
node sandwich-1.cjs > logs/sandwich-1.log 2>&1 &
echo "PID: $!"

echo "Starting sandwich-2..."
node sandwich-2.cjs > logs/sandwich-2.log 2>&1 &
echo "PID: $!"

echo "Starting sandwich-3..."
node sandwich-3.cjs > logs/sandwich-3.log 2>&1 &
echo "PID: $!"

echo "Starting sandwich-4..."
node sandwich-4.cjs > logs/sandwich-4.log 2>&1 &
echo "PID: $!"

echo "Starting sandwich-5..."
node sandwich-5.cjs > logs/sandwich-5.log 2>&1 &
echo "PID: $!"

echo ""
echo "✅ All 5 sandwich bots launched!"
echo "📊 Monitor logs with: tail -f logs/sandwich-*.log"
echo "🛑 Stop all with: pkill -f 'node sandwich-'"
echo ""
echo "Showing combined output (Ctrl+C to exit):"
echo "========================================="

# Show combined output
tail -f logs/sandwich-*.log