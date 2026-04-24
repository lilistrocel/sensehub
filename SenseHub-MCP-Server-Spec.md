# SenseHub MCP Server Specification

## Overview

This document specifies the Model Context Protocol (MCP) server to be implemented on SenseHub Raspberry Pi devices. The MCP server exposes SenseHub equipment, automations, and alerts as MCP tools and resources, enabling AI assistants on the A64 Core Platform to interact with farm hardware using natural language.

**Phase 2 deliverable** - Phase 1 uses HTTP proxy via A64 backend. This spec is for the SenseHub team to build the MCP server when ready.

## Architecture

```
A64 Backend (MCP Client)
  |
  SSE connection
  |
  v
SenseHub Pi (MCP Server) @ http://{pi-address}:3001/mcp
  |
  Internal API calls
  |
  v
SenseHub Core API @ http://localhost:3000
```

## Transport

- **Protocol**: Server-Sent Events (SSE)
- **Port**: 3001 (separate from main API on 3000)
- **Endpoint**: `http://{pi-address}:3001/mcp`
- **Authentication**: JWT token (same credentials as existing SenseHub API login)

### Authentication Flow

1. MCP client sends JWT in initial SSE connection headers: `Authorization: Bearer <token>`
2. Server validates token against same auth system as main API
3. On 401, client re-authenticates via `POST /api/auth/login` on port 3000, then reconnects

## Implementation

- **Runtime**: Node.js
- **SDK**: `@modelcontextprotocol/sdk` package
- **Internal API**: Calls SenseHub Core API at `http://localhost:3000/api/*` using existing endpoints

## Tools

### Read Tools (no side effects)

#### `get_equipment_list`
List all sensors and relays with current status.

```json
{
  "name": "get_equipment_list",
  "description": "List all SenseHub equipment with current status, type, zone, and latest readings.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["online", "offline", "error"] },
      "zone": { "type": "string" }
    }
  }
}
```

**Advantage over HTTP proxy**: Tool description dynamically includes equipment names and zones. Example: `"...Available sensors: 'Greenhouse Temp/Humidity (ID 1)', 'Soil Moisture A (ID 3)'..."`

#### `get_sensor_readings`
Get current or historical readings for a specific sensor.

```json
{
  "name": "get_sensor_readings",
  "description": "Get readings from sensor equipment. Returns temperature, humidity, pH, EC, light, etc.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "equipment_id": { "type": "integer", "description": "Equipment ID" },
      "from": { "type": "string", "format": "date-time" },
      "to": { "type": "string", "format": "date-time" },
      "limit": { "type": "integer", "default": 10 }
    },
    "required": ["equipment_id"]
  }
}
```

#### `get_automations`
List all automation programs.

```json
{
  "name": "get_automations",
  "description": "List all automation programs with name, enabled status, schedule, and last run.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

#### `get_alerts`
Get active alerts.

```json
{
  "name": "get_alerts",
  "description": "Get active alerts with severity, equipment, zone, and acknowledgement status.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "severity": { "type": "string", "enum": ["critical", "warning", "info"] },
      "acknowledged": { "type": "boolean" }
    }
  }
}
```

#### `get_system_status`
System health and diagnostics.

```json
{
  "name": "get_system_status",
  "description": "Get SenseHub health including uptime, version, CPU/memory, connectivity.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

### Write Tools (side effects)

The A64 backend handles confirmation flow. MCP server executes tools as requested.

#### `control_relay`
```json
{
  "name": "control_relay",
  "description": "Control a relay channel (ON/OFF). Controls pumps, fans, lights, valves.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "equipment_id": { "type": "integer" },
      "channel": { "type": "integer" },
      "state": { "type": "boolean" }
    },
    "required": ["equipment_id", "channel", "state"]
  }
}
```

#### `trigger_automation`
```json
{
  "name": "trigger_automation",
  "description": "Manually trigger an automation program to run once immediately.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "automation_id": { "type": "integer" }
    },
    "required": ["automation_id"]
  }
}
```

#### `toggle_automation`
```json
{
  "name": "toggle_automation",
  "description": "Enable or disable an automation program.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "automation_id": { "type": "integer" }
    },
    "required": ["automation_id"]
  }
}
```

## Resources

MCP resources provide context that the AI can reference without explicit tool calls.

### `sensehub://equipment`
Dynamic resource listing all equipment with current status. Updated when equipment configuration changes.

```json
{
  "uri": "sensehub://equipment",
  "name": "Equipment List",
  "description": "All registered sensors and relays with current status",
  "mimeType": "application/json"
}
```

### `sensehub://automations`
Dynamic resource listing all automation programs.

```json
{
  "uri": "sensehub://automations",
  "name": "Automations",
  "description": "All configured automation programs",
  "mimeType": "application/json"
}
```

### `sensehub://alerts`
Dynamic resource with active (unacknowledged) alerts.

```json
{
  "uri": "sensehub://alerts",
  "name": "Active Alerts",
  "description": "Currently active alerts requiring attention",
  "mimeType": "application/json"
}
```

## Resource Subscriptions

Clients can subscribe to resource updates. The server pushes notifications when:

- Equipment status changes (online/offline)
- New sensor reading arrives (throttled to 1 update per 30 seconds per equipment)
- Alert is created or acknowledged
- Automation is enabled/disabled/triggered

## Dynamic Tool Descriptions

Key advantage of MCP over HTTP proxy: tool descriptions include real equipment names.

When equipment configuration changes, the server regenerates tool descriptions:

```javascript
// Example: get_equipment_list description includes actual equipment names
const equipment = await fetchEquipment();
const names = equipment.map(e => `'${e.name} (ID ${e.id}, ${e.type})'`).join(', ');
const description = `List all SenseHub equipment. Available: ${names}`;
```

This helps the AI make correct tool calls without needing a lookup step first.

## Implementation Skeleton

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';

const server = new McpServer({
  name: 'sensehub',
  version: '1.0.0',
});

// Register tools
server.tool('get_equipment_list', { /* schema */ }, async (args) => {
  const data = await fetch('http://localhost:3000/api/equipment', { headers: authHeaders });
  return { content: [{ type: 'text', text: JSON.stringify(await data.json()) }] };
});

// Register resources
server.resource('sensehub://equipment', { /* metadata */ }, async () => {
  const data = await fetch('http://localhost:3000/api/equipment', { headers: authHeaders });
  return { contents: [{ uri: 'sensehub://equipment', text: JSON.stringify(await data.json()) }] };
});

// SSE transport on port 3001
const app = express();
const transport = new SSEServerTransport('/mcp', app);
app.listen(3001);
await server.connect(transport);
```

## A64 Backend Integration (Phase 2)

When the MCP server is available, the A64 backend will:

1. Replace `SenseHubClient` HTTP calls with MCP client connection
2. Use `@modelcontextprotocol/sdk` Python client (`mcp` package)
3. Connect via SSE to `http://{pi-address}:3001/mcp`
4. Pass MCP tools directly to Claude's `tools` parameter
5. Subscribe to resource updates for real-time sensor data push

The existing HTTP proxy endpoints remain available as fallback.

## Testing

1. **Health**: `curl http://{pi-address}:3001/health` returns `{ "status": "ok" }`
2. **Tool list**: Connect MCP client, verify 8 tools registered
3. **Read tool**: Call `get_equipment_list`, verify equipment data returned
4. **Write tool**: Call `control_relay`, verify relay state changes
5. **Resource**: Read `sensehub://equipment`, verify JSON equipment list
6. **Subscription**: Subscribe to `sensehub://alerts`, trigger an alert, verify notification received

## Timeline

| Milestone | Description |
|-----------|-------------|
| Phase 1 (current) | A64 backend uses HTTP proxy via `SenseHubClient` |
| Phase 2a | SenseHub team implements MCP server on Pi |
| Phase 2b | A64 backend adds MCP client as alternative transport |
| Phase 3 | Real-time resource subscriptions for live sensor dashboard |
