#!/bin/bash

# SenseHub - Edge Computing Platform for Raspberry Pi 5
# Development Environment Initialization Script

set -e

echo "=========================================="
echo "  SenseHub Development Environment Setup"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
FRONTEND_PORT=3000
BACKEND_PORT=3001
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if a port is in use
port_in_use() {
    lsof -ti:$1 >/dev/null 2>&1
}

# Function to wait for a service to be ready
wait_for_service() {
    local url=$1
    local max_attempts=${2:-30}
    local attempt=1

    echo -e "${YELLOW}Waiting for service at $url...${NC}"
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" >/dev/null 2>&1; then
            echo -e "${GREEN}Service is ready!${NC}"
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    echo -e "${RED}Service failed to start within $max_attempts seconds${NC}"
    return 1
}

echo ""
echo -e "${BLUE}Checking prerequisites...${NC}"

# Check Node.js
if ! command_exists node; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ is required. Found version $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check npm
if ! command_exists npm; then
    echo -e "${RED}Error: npm is not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# Check for SQLite (optional, for direct database access)
if command_exists sqlite3; then
    echo -e "${GREEN}✓ SQLite3 available${NC}"
else
    echo -e "${YELLOW}⚠ SQLite3 CLI not found (optional)${NC}"
fi

echo ""
echo -e "${BLUE}Setting up backend...${NC}"

# Setup backend
if [ -d "$PROJECT_ROOT/backend" ]; then
    cd "$PROJECT_ROOT/backend"

    if [ ! -d "node_modules" ]; then
        echo "Installing backend dependencies..."
        npm install
    else
        echo "Backend dependencies already installed"
    fi

    # Initialize database if needed
    if [ ! -f "data/sensehub.db" ]; then
        echo "Initializing database..."
        mkdir -p data
        npm run db:init 2>/dev/null || echo "Database will be initialized on first run"
    fi
else
    echo -e "${YELLOW}Backend directory not found. Skipping backend setup.${NC}"
fi

echo ""
echo -e "${BLUE}Setting up frontend...${NC}"

# Setup frontend
if [ -d "$PROJECT_ROOT/frontend" ]; then
    cd "$PROJECT_ROOT/frontend"

    if [ ! -d "node_modules" ]; then
        echo "Installing frontend dependencies..."
        npm install
    else
        echo "Frontend dependencies already installed"
    fi
else
    echo -e "${YELLOW}Frontend directory not found. Skipping frontend setup.${NC}"
fi

cd "$PROJECT_ROOT"

echo ""
echo -e "${BLUE}Starting services...${NC}"

# Kill any existing processes on our ports
if port_in_use $BACKEND_PORT; then
    echo "Stopping existing backend on port $BACKEND_PORT..."
    lsof -ti:$BACKEND_PORT | xargs kill -9 2>/dev/null || true
    sleep 2
fi

if port_in_use $FRONTEND_PORT; then
    echo "Stopping existing frontend on port $FRONTEND_PORT..."
    lsof -ti:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# Start backend
if [ -d "$PROJECT_ROOT/backend" ]; then
    echo "Starting backend server..."
    cd "$PROJECT_ROOT/backend"
    npm run dev > ../logs/backend.log 2>&1 &
    BACKEND_PID=$!
    echo "Backend PID: $BACKEND_PID"
fi

# Start frontend
if [ -d "$PROJECT_ROOT/frontend" ]; then
    echo "Starting frontend server..."
    cd "$PROJECT_ROOT/frontend"
    npm run dev > ../logs/frontend.log 2>&1 &
    FRONTEND_PID=$!
    echo "Frontend PID: $FRONTEND_PID"
fi

cd "$PROJECT_ROOT"

# Create logs directory if it doesn't exist
mkdir -p logs

# Wait for services to be ready
echo ""
if [ -d "$PROJECT_ROOT/backend" ]; then
    wait_for_service "http://localhost:$BACKEND_PORT/api/health" 30 || true
fi

if [ -d "$PROJECT_ROOT/frontend" ]; then
    wait_for_service "http://localhost:$FRONTEND_PORT" 30 || true
fi

echo ""
echo "=========================================="
echo -e "${GREEN}  SenseHub is running!${NC}"
echo "=========================================="
echo ""
echo -e "  ${BLUE}Frontend:${NC} http://localhost:$FRONTEND_PORT"
echo -e "  ${BLUE}Backend API:${NC} http://localhost:$BACKEND_PORT/api"
echo -e "  ${BLUE}Health Check:${NC} http://localhost:$BACKEND_PORT/api/health"
echo ""
echo -e "  ${YELLOW}Logs:${NC}"
echo "    - Backend: logs/backend.log"
echo "    - Frontend: logs/frontend.log"
echo ""
echo -e "  ${YELLOW}To stop:${NC} Press Ctrl+C or run:"
echo "    lsof -ti:$FRONTEND_PORT,$BACKEND_PORT | xargs kill -9"
echo ""
echo "=========================================="

# Keep script running to maintain child processes
wait
