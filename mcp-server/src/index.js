const crypto = require('crypto');
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const SenseHubAPIClient = require('./api-client');

// --- Configuration ---
const PORT = parseInt(process.env.PORT || '3001', 10);
const API_URL = process.env.SENSEHUB_API_URL || 'http://localhost:3003';
const MCP_EMAIL = process.env.MCP_SENSEHUB_EMAIL || 'lilistrocel@gmail.com';
const MCP_PASSWORD = process.env.MCP_SENSEHUB_PASSWORD || 'Katana123';
const API_KEY = process.env.MCP_API_KEY || 'sensehub-mcp-default-key';

const api = new SenseHubAPIClient(API_URL, MCP_EMAIL, MCP_PASSWORD);

// --- Equipment cache for dynamic descriptions ---
let equipmentList = [];

async function refreshEquipmentList() {
  try {
    const data = await api.get('/api/equipment');
    equipmentList = Array.isArray(data) ? data : [];
    console.log(`[mcp] Refreshed equipment list: ${equipmentList.length} devices`);
  } catch (err) {
    console.error('[mcp] Failed to refresh equipment list:', err.message);
  }
}

function getEquipmentSummary() {
  if (equipmentList.length === 0) return 'No equipment registered yet.';
  return equipmentList
    .map((e) => `'${e.name}' (ID ${e.id}, ${e.type}, ${e.status})`)
    .join(', ');
}

// --- MCP Server Setup ---
function createMcpServer() {
  const server = new McpServer({
    name: 'sensehub',
    version: '1.0.0',
  });

  // ========== TOOLS ==========

  server.tool(
    'get_equipment_list',
    `List all SenseHub equipment with current status. Available: ${getEquipmentSummary()}`,
    {
      status: z.enum(['online', 'offline', 'error', 'unknown']).optional().describe('Filter by status'),
      search: z.string().optional().describe('Search by name'),
      zone: z.string().optional().describe('Filter by zone name'),
    },
    async ({ status, search, zone }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      if (zone) params.set('zone', zone);
      const qs = params.toString();
      const data = await api.get(`/api/equipment${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_sensor_readings',
    'Get historical sensor readings for a specific equipment device. Returns timestamped values with statistics.',
    {
      equipment_id: z.number().int().describe('Equipment ID'),
      from: z.string().optional().describe('Start datetime (ISO 8601)'),
      to: z.string().optional().describe('End datetime (ISO 8601)'),
      limit: z.number().int().optional().describe('Max readings to return (default 25)'),
    },
    async ({ equipment_id, from, to, limit }) => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await api.get(`/api/equipment/${equipment_id}/history${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_automations',
    'List all automation programs with their trigger configs, conditions, actions, and run counts.',
    {},
    async () => {
      const data = await api.get('/api/automations');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_alerts',
    'Get system alerts. Filter by severity or acknowledgement status.',
    {
      severity: z.enum(['info', 'warning', 'critical']).optional().describe('Filter by severity'),
      acknowledged: z.enum(['true', 'false']).optional().describe('Filter by acknowledgement status'),
    },
    async ({ severity, acknowledged }) => {
      const params = new URLSearchParams();
      if (severity) params.set('severity', severity);
      if (acknowledged) params.set('acknowledged', acknowledged);
      const qs = params.toString();
      const data = await api.get(`/api/alerts${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_system_status',
    'Get SenseHub system information: version, uptime, memory usage, CPU count, database status.',
    {},
    async () => {
      const data = await api.get('/api/system/info');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'control_relay',
    'Turn a relay channel on or off on relay equipment. Use get_equipment_list first to find relay IDs and channel numbers.',
    {
      equipment_id: z.number().int().describe('Relay equipment ID'),
      channel: z.number().int().describe('Coil address / channel number'),
      state: z.boolean().describe('true = ON, false = OFF'),
    },
    async ({ equipment_id, channel, state }) => {
      const data = await api.post(`/api/equipment/${equipment_id}/relay/control`, { channel, state });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'trigger_automation',
    'Manually trigger an automation program to execute its actions immediately.',
    {
      automation_id: z.number().int().describe('Automation ID'),
    },
    async ({ automation_id }) => {
      const data = await api.post(`/api/automations/${automation_id}/trigger`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'toggle_automation',
    'Enable or disable an automation program.',
    {
      automation_id: z.number().int().describe('Automation ID'),
    },
    async ({ automation_id }) => {
      const data = await api.post(`/api/automations/${automation_id}/toggle`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ========== RESOURCES ==========

  server.resource(
    'equipment',
    'sensehub://equipment',
    { description: 'All registered equipment with current status and last readings' },
    async () => {
      const data = await api.get('/api/equipment');
      return { contents: [{ uri: 'sensehub://equipment', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'automations',
    'sensehub://automations',
    { description: 'All automation programs with configs and run history' },
    async () => {
      const data = await api.get('/api/automations');
      return { contents: [{ uri: 'sensehub://automations', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'alerts',
    'sensehub://alerts',
    { description: 'Unacknowledged alerts requiring attention' },
    async () => {
      const data = await api.get('/api/alerts?acknowledged=false');
      return { contents: [{ uri: 'sensehub://alerts', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// --- Express App ---
const app = express();

// API key middleware for MCP endpoint
function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const key = authHeader.slice(7);
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'sensehub-mcp',
    version: '1.0.0',
    equipment_count: equipmentList.length,
    backend_connected: !!api.token,
  });
});

// MCP endpoint - Streamable HTTP with session management
const sessions = {};

app.post('/mcp', requireApiKey, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions[sessionId]) {
      // Existing session
      await sessions[sessionId].handleRequest(req, res);
      return;
    }

    // New session — session ID is assigned during handleRequest when initialize is processed
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions[sessionId] = transport;
        console.log(`[mcp] Session ${sessionId} initialized`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        delete sessions[transport.sessionId];
        console.log(`[mcp] Session ${transport.sessionId} closed`);
      }
    };
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] Request error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.get('/mcp', requireApiKey, (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].handleRequest(req, res);
  } else {
    res.status(400).json({ error: 'No valid session. Send POST to initialize.' });
  }
});

app.delete('/mcp', requireApiKey, (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions[sessionId]) {
    sessions[sessionId].close();
    delete sessions[sessionId];
    res.status(200).json({ message: 'Session closed' });
  } else {
    res.status(400).json({ error: 'No valid session' });
  }
});

// --- Startup ---
async function start() {
  console.log('[mcp] SenseHub MCP Server starting...');
  console.log(`[mcp] Backend API: ${API_URL}`);

  // Authenticate with backend
  let retries = 0;
  while (retries < 10) {
    try {
      await api.login();
      break;
    } catch (err) {
      retries++;
      console.error(`[mcp] Backend login attempt ${retries}/10 failed: ${err.message}`);
      if (retries >= 10) {
        console.error('[mcp] Could not authenticate with backend. Exiting.');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Initial equipment fetch
  await refreshEquipmentList();

  // Periodic refresh every 60s
  setInterval(refreshEquipmentList, 60000);

  app.listen(PORT, () => {
    console.log(`[mcp] MCP Server listening on port ${PORT}`);
    console.log(`[mcp] Health: http://localhost:${PORT}/health`);
    console.log(`[mcp] MCP endpoint: POST http://localhost:${PORT}/mcp`);
  });
}

start().catch((err) => {
  console.error('[mcp] Fatal error:', err);
  process.exit(1);
});
