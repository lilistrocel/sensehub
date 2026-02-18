# SenseHub MCP Server

A Model Context Protocol (MCP) server that exposes SenseHub farm hardware to AI assistants via natural language. It runs as a Docker service on the same Raspberry Pi 5 as SenseHub, proxying all requests through the existing REST API.

## Connection Details

- **Endpoint:** `POST http://<sensehub-ip>:3001/mcp`
- **Transport:** Streamable HTTP (MCP spec 2025-03-26)
- **Auth:** `Authorization: Bearer <MCP_API_KEY>` (default: `sensehub-mcp-default-key`)
- **Health:** `GET http://<sensehub-ip>:3001/health`

## Available Tools (8)

| Tool | What It Does | Params |
|------|-------------|--------|
| `get_equipment_list` | List all sensors & relays with live status | `status?`, `search?`, `zone?` |
| `get_sensor_readings` | Historical readings with stats | `equipment_id`, `from?`, `to?`, `limit?` |
| `get_automations` | List all automation programs | — |
| `get_alerts` | System alerts | `severity?`, `acknowledged?` |
| `get_system_status` | System info, uptime, memory, DB status | — |
| `control_relay` | Turn relay channel on/off | `equipment_id`, `channel`, `state` |
| `trigger_automation` | Manually fire an automation | `automation_id` |
| `toggle_automation` | Enable/disable an automation | `automation_id` |

## Available Resources (3)

| URI | Description |
|-----|-------------|
| `sensehub://equipment` | All equipment with current status |
| `sensehub://automations` | All automation programs |
| `sensehub://alerts` | Unacknowledged alerts |

## Dynamic Tool Descriptions

`get_equipment_list` includes live equipment names in its description so the AI knows what's available without calling it first:

> *"List all SenseHub equipment. Available: '7-in-1 Soil Meter' (ID 7, sensor, online), 'Waveshare Irrigation 1' (ID 1, relay, online)..."*

Equipment list refreshes every 60 seconds.

## Session Flow

```
1. POST /mcp  →  {"method":"initialize", ...}           → gets Mcp-Session-Id header
2. POST /mcp  →  {"method":"notifications/initialized"}  (with session header)
3. POST /mcp  →  {"method":"tools/call", ...}            (with session header)
```

## Architecture

```
A64 Backend (MCP Client)
  → POST :3001/mcp  [Bearer MCP_API_KEY]
    → SenseHub MCP Server (Docker, host network)
      → http://localhost:3003/api/*  [Bearer JWT]
        → SenseHub Backend API → SQLite + Modbus hardware
```

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `MCP_API_KEY` | `sensehub-mcp-default-key` | API key for MCP clients |
| `MCP_SENSEHUB_EMAIL` | `lilistrocel@gmail.com` | Backend login email |
| `MCP_SENSEHUB_PASSWORD` | `Katana123` | Backend login password |
| `PORT` | `3001` | MCP server port |
| `SENSEHUB_API_URL` | `http://localhost:3003` | Backend API URL |

## Current Hardware (9 devices online)

- 4x RS485 Fan Control Relay Boards
- 2x Waveshare Irrigation Relays (6-channel each)
- 2x SHT20 Temp/Humidity Sensors
- 1x 7-in-1 Soil Meter (temp, humidity, pH, NPK, EC, moisture)
