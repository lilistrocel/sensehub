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

  server.tool(
    'get_lab_readings',
    'Get lab analysis readings (manual nutrient measurements). Filter by nutrient, zone, or date range. Returns paginated results with value, unit, sample date, zone, and notes.',
    {
      nutrient: z.string().optional().describe('Filter by nutrient ID (e.g., nitrogen_N, pH, EC, potassium_K)'),
      zone_id: z.number().int().optional().describe('Filter by zone ID'),
      from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      limit: z.number().int().optional().describe('Max readings to return (default 25)'),
    },
    async ({ nutrient, zone_id, from, to, limit }) => {
      const params = new URLSearchParams();
      if (nutrient) params.set('nutrient', nutrient);
      if (zone_id) params.set('zone_id', String(zone_id));
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await api.get(`/api/lab-readings${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_lab_latest',
    'Get the latest lab reading for each nutrient, optionally filtered by zone. Useful for a quick snapshot of current nutrient levels.',
    {
      zone_id: z.number().int().optional().describe('Filter by zone ID to see readings for a specific zone (e.g., fertigation vs drain)'),
    },
    async ({ zone_id }) => {
      const params = new URLSearchParams();
      if (zone_id) params.set('zone_id', String(zone_id));
      const qs = params.toString();
      const data = await api.get(`/api/lab-readings/latest${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_lab_stats',
    'Get statistical summary (avg, min, max, count) per nutrient from lab readings. Filter by zone or date range.',
    {
      zone_id: z.number().int().optional().describe('Filter by zone ID'),
      from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      to: z.string().optional().describe('End date (YYYY-MM-DD)'),
    },
    async ({ zone_id, from, to }) => {
      const params = new URLSearchParams();
      if (zone_id) params.set('zone_id', String(zone_id));
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const qs = params.toString();
      const data = await api.get(`/api/lab-readings/stats${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_lab_nutrients',
    'Get the list of available nutrient types that can be used in lab readings. Returns IDs, names, categories, and default units.',
    {},
    async () => {
      const data = await api.get('/api/lab-readings/nutrients');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ========== CAMERA TOOLS ==========

  server.tool(
    'get_cameras',
    'List all cameras with their status, IP address, model, and stream info.',
    {},
    async () => {
      const data = await api.get('/api/cameras');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'capture_camera_snapshot',
    'Capture a snapshot from a camera right now and store it. Returns the snapshot metadata (filename, size, timestamp). Use get_cameras first to find camera IDs.',
    {
      camera_id: z.number().int().describe('Camera ID'),
    },
    async ({ camera_id }) => {
      const data = await api.post(`/api/cameras/${camera_id}/capture`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_camera_snapshots',
    'Get stored snapshot history for a camera. Snapshots are captured automatically every 4 hours. Returns list of snapshots with filenames, sizes, and capture timestamps.',
    {
      camera_id: z.number().int().describe('Camera ID'),
      limit: z.number().int().optional().describe('Max snapshots to return (default 42, ~7 days)'),
    },
    async ({ camera_id, limit }) => {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const data = await api.get(`/api/cameras/${camera_id}/snapshots${qs ? '?' + qs : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_camera_snapshot_image',
    'Get the URL for a stored camera snapshot image. Returns the URL path that can be used to view/download the JPEG image. Use get_camera_snapshots first to find filenames.',
    {
      filename: z.string().describe('Snapshot filename (e.g., cam_1_2026-03-25T09-22-03-497Z.jpg)'),
    },
    async ({ filename }) => {
      const url = `${API_URL}/api/cameras/snapshots/file/${encodeURIComponent(filename)}`;
      return { content: [{ type: 'text', text: JSON.stringify({ url, note: 'This URL serves the JPEG image directly. No auth required.' }, null, 2) }] };
    }
  );

  // ========== CROP DATA TOOLS (A64Core Contract) ==========

  server.tool(
    'set_crop_data',
    'Assign a crop to a SenseHub block. Called by A64Core when a crop is planted. Atomically replaces any prior active crop on that block_id. All optimal_ranges values are {min, max, unit} objects.',
    {
      block_id: z.string().describe('A64Core block UUID'),
      a64core_planting_id: z.string().optional().describe('A64Core planting document UUID'),
      crop: z.object({
        plant_data_id: z.string().optional(),
        name: z.string(),
        variety: z.string().optional(),
        scientific_name: z.string().optional()
      }),
      timing: z.object({
        planted_date: z.string().optional(),
        expected_harvest_date: z.string().optional(),
        growth_cycle_days: z.number().optional()
      }).optional(),
      population: z.object({
        plant_count: z.number().optional(),
        max_capacity: z.number().optional()
      }).optional(),
      current_stage: z.string().optional().describe('seedling|vegetative|flowering|fruiting|ripening'),
      optimal_ranges: z.record(z.any()).optional().describe('Keys: ec, ph, temperature, humidity, water, light. Values: {min, max, unit}'),
      stage_durations_days: z.record(z.number()).optional().describe('Expected days per stage: {seedling:14, vegetative:28, ...}')
    },
    async ({ block_id, a64core_planting_id, crop, timing, population, current_stage, optimal_ranges, stage_durations_days }) => {
      const data = await api.post('/api/crops', {
        block_id, a64core_planting_id, crop, timing, population,
        current_stage, optimal_ranges, stage_durations_days
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'get_crop_data',
    'Get the active crop assignment for a block. Returns the full crop payload (same shape as set_crop_data) plus sensehub_crop_id, received_at, and last_stage_update_at. Returns null if no active crop.',
    {
      block_id: z.string().describe('A64Core block UUID'),
    },
    async ({ block_id }) => {
      const data = await api.get(`/api/crops/by-block/${encodeURIComponent(block_id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'update_growth_stage',
    'Update the growth stage of the active crop on a block. Called by A64Core when the computed stage advances. Valid stages: seedling, vegetative, flowering, fruiting, ripening, harvested.',
    {
      block_id: z.string().describe('A64Core block UUID'),
      stage: z.string().describe('New stage: seedling|vegetative|flowering|fruiting|ripening|harvested'),
      transitioned_at: z.string().optional().describe('ISO 8601 UTC timestamp of the transition'),
      days_since_planting: z.number().optional().describe('Days elapsed since planting at time of transition')
    },
    async ({ block_id, stage, transitioned_at, days_since_planting }) => {
      const data = await api.post(`/api/crops/0/stage`, { block_id, stage, transitioned_at, days_since_planting });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'complete_crop',
    'Mark the active crop on a block as harvested/completed. Called by A64Core when harvest is finalized. SenseHub archives the record and stops stage-based automations until a new set_crop_data arrives.',
    {
      block_id: z.string().describe('A64Core block UUID'),
      harvested_at: z.string().optional().describe('ISO 8601 UTC harvest timestamp'),
      total_yield_kg: z.number().optional().describe('Cumulative yield in kg'),
      average_quality_grade: z.string().optional().describe('A, B, C, or D'),
      harvest_count: z.number().optional().describe('Number of discrete harvest events')
    },
    async ({ block_id, harvested_at, total_yield_kg, average_quality_grade, harvest_count }) => {
      const data = await api.post(`/api/crops/0/complete`, { block_id, harvested_at, total_yield_kg, average_quality_grade, harvest_count });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ========== BLOCK MAPPING TOOLS ==========

  server.tool(
    'configure_block_mapping',
    'Associate a SenseHub zone with an A64Core block UUID. Idempotent. This is optional — if a primary crop zone is configured, set_crop_data routes automatically. Only needed for multi-zone sites.',
    {
      zone_id: z.number().int().describe('SenseHub zone ID'),
      block_id: z.string().describe('A64Core block UUID'),
      block_code: z.string().optional().describe('Human-readable block code (e.g., "GH1-A")'),
      block_name: z.string().optional().describe('Display name for the block')
    },
    async ({ zone_id, block_id, block_code, block_name }) => {
      const data = await api.post('/api/crops/configure-block-mapping', { zone_id, block_id, block_code, block_name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'list_zone_mappings',
    'List all SenseHub zones with block mappings and which is the primary crop zone. Zones with no mapping show block_id: null. Includes primary_crop_zone_id.',
    {},
    async () => {
      const data = await api.get('/api/crops/zone-mappings');
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

  server.resource(
    'crops',
    'sensehub://crops',
    { description: 'Active crop assignments per zone with plant parameters and growth stages' },
    async () => {
      const data = await api.get('/api/crops');
      return { contents: [{ uri: 'sensehub://crops', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'cameras',
    'sensehub://cameras',
    { description: 'All cameras with status and latest snapshot info' },
    async () => {
      const data = await api.get('/api/cameras');
      return { contents: [{ uri: 'sensehub://cameras', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'lab-readings',
    'sensehub://lab-readings',
    { description: 'Latest lab analysis readings per nutrient per zone' },
    async () => {
      const data = await api.get('/api/lab-readings/latest');
      return { contents: [{ uri: 'sensehub://lab-readings', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
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
