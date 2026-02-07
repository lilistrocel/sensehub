# SenseHub

**Dockerized Edge Computing Platform for Raspberry Pi 5**

SenseHub is the local "brain" for industrial IoT operations. It manages field equipment (sensors, relays, controllers, nodes), runs automation programs, and syncs with a centralized Cloud platform. The system operates fully offline-first, ensuring complete autonomy even without cloud connectivity.

## Features

- **Equipment Management**: Discover, configure, and monitor sensors and controllers via Modbus, MQTT, Zigbee, and Z-Wave protocols
- **Zone Organization**: Organize equipment into logical zones with hierarchical structure
- **Automation Builder**: Visual no-code automation builder with triggers, conditions, and actions
- **Real-time Dashboard**: Live monitoring with customizable widgets and historical charts
- **Alert System**: Configurable alerts with severity levels and acknowledgment workflow
- **Cloud Sync**: Bi-directional sync with cloud platform (offline-first architecture)
- **Role-based Access**: Admin, Operator, and Viewer roles with granular permissions

## Technology Stack

### Frontend
- React with Vite
- Tailwind CSS
- React Context + useReducer for state management
- WebSocket for real-time updates

### Backend
- Node.js with Express.js
- SQLite database (better-sqlite3)
- REST API
- WebSocket server

### Deployment
- Docker & Docker Compose
- Optimized for Raspberry Pi 5

## Prerequisites

- Node.js 18+ (for development)
- Docker & Docker Compose (for deployment)
- SQLite3 (optional, for database inspection)

## Quick Start

### Development Mode

```bash
# Clone the repository
git clone <repository-url>
cd SenseHub

# Start the development environment
./init.sh
```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001/api

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f
```

## Project Structure

```
SenseHub/
├── frontend/               # React frontend application
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── pages/          # Page components
│   │   ├── context/        # React Context providers
│   │   ├── hooks/          # Custom React hooks
│   │   ├── services/       # API service functions
│   │   └── utils/          # Utility functions
│   └── public/             # Static assets
├── backend/                # Node.js backend server
│   ├── src/
│   │   ├── routes/         # API route handlers
│   │   ├── middleware/     # Express middleware
│   │   ├── models/         # Database models
│   │   ├── services/       # Business logic
│   │   └── utils/          # Utility functions
│   └── data/               # SQLite database
├── docker/                 # Docker configuration
├── logs/                   # Application logs
├── init.sh                 # Development setup script
└── docker-compose.yml      # Docker Compose configuration
```

## Database Schema

The application uses SQLite with the following main tables:

- `users` - User accounts and authentication
- `sessions` - Active user sessions
- `equipment` - Registered sensors and controllers
- `zones` - Organizational zones
- `equipment_zones` - Equipment-to-zone associations
- `readings` - Sensor readings (time-series)
- `automations` - Automation programs
- `automation_logs` - Automation execution history
- `alerts` - System alerts
- `system_settings` - Configuration settings
- `sync_queue` - Pending cloud sync operations

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/session` - Get current session

### Equipment
- `GET /api/equipment` - List all equipment
- `POST /api/equipment` - Add new equipment
- `GET /api/equipment/:id` - Get equipment details
- `PUT /api/equipment/:id` - Update equipment
- `DELETE /api/equipment/:id` - Delete equipment
- `POST /api/equipment/scan` - Discover equipment
- `POST /api/equipment/:id/control` - Control equipment

### Zones
- `GET /api/zones` - List all zones
- `POST /api/zones` - Create zone
- `GET /api/zones/:id` - Get zone details
- `PUT /api/zones/:id` - Update zone
- `DELETE /api/zones/:id` - Delete zone

### Automations
- `GET /api/automations` - List automations
- `POST /api/automations` - Create automation
- `GET /api/automations/:id` - Get automation details
- `PUT /api/automations/:id` - Update automation
- `DELETE /api/automations/:id` - Delete automation
- `POST /api/automations/:id/test` - Test automation

### Alerts
- `GET /api/alerts` - List alerts
- `POST /api/alerts/:id/acknowledge` - Acknowledge alert

### System
- `GET /api/health` - Health check
- `GET /api/system/info` - System information

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access - manage users, system settings, equipment, automations |
| **Operator** | Control equipment, create automations, acknowledge alerts |
| **Viewer** | View-only access to dashboards and monitoring data |

## Environment Variables

```env
# Backend
PORT=3001
NODE_ENV=development
JWT_SECRET=your-secret-key
DB_PATH=./data/sensehub.db
SESSION_TIMEOUT=28800000  # 8 hours in milliseconds

# Frontend
VITE_API_URL=http://localhost:3001/api
VITE_WS_URL=ws://localhost:3001
```

## Development

### Running Tests

```bash
# Backend tests
cd backend
npm test

# Frontend tests
cd frontend
npm test
```

### Linting

```bash
# Backend
cd backend
npm run lint

# Frontend
cd frontend
npm run lint
```

## Deployment on Raspberry Pi 5

1. Install Docker on Raspberry Pi OS:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```

2. Clone and deploy:
   ```bash
   git clone <repository-url>
   cd SenseHub
   docker-compose up -d
   ```

3. Access at `http://<raspberry-pi-ip>:3000`

## License

Proprietary - All rights reserved

## Support

For issues and feature requests, please open an issue in the repository.
