const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'sensehub.db');
let db = null;

try {
  db = new Database(dbPath, { verbose: process.env.NODE_ENV === 'development' ? console.log : null });
  db.pragma('journal_mode = WAL');
  console.log(`Database connected: ${dbPath}`);
} catch (error) {
  console.error('Failed to connect to database:', error);
}

// Initialize schema
const initSchema = () => {
  if (!db) return false;

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'operator', 'viewer')) NOT NULL DEFAULT 'viewer',
      is_cloud_synced INTEGER DEFAULT 0,
      last_login TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Equipment table
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT,
      protocol TEXT CHECK(protocol IN ('modbus', 'mqtt', 'zigbee', 'zwave', 'other')),
      address TEXT,
      status TEXT CHECK(status IN ('online', 'offline', 'error', 'warning', 'disabled')) DEFAULT 'offline',
      enabled INTEGER DEFAULT 1,
      last_reading TEXT,
      last_communication TEXT,
      error_log TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Zones table
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      parent_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES zones(id) ON DELETE SET NULL
    );

    -- Equipment-Zones junction table
    CREATE TABLE IF NOT EXISTS equipment_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
      UNIQUE(equipment_id, zone_id)
    );

    -- Readings table
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      value REAL,
      unit TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- Automations table
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      trigger_config TEXT,
      conditions TEXT,
      actions TEXT,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Automation logs table
    CREATE TABLE IF NOT EXISTS automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('success', 'failure', 'skipped')),
      message TEXT,
      triggered_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
    );

    -- Alerts table
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER,
      zone_id INTEGER,
      severity TEXT CHECK(severity IN ('info', 'warning', 'critical')) NOT NULL,
      message TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at TEXT,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE SET NULL,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL,
      FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- System settings table
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Sync queue table
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT CHECK(action IN ('create', 'update', 'delete')) NOT NULL,
      payload TEXT,
      status TEXT CHECK(status IN ('pending', 'syncing', 'synced', 'failed')) DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      synced_at TEXT
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_readings_equipment ON readings(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
    CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON automation_logs(automation_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
  `);

  console.log('Database schema initialized');
  return true;
};

// Initialize schema on module load
initSchema();

module.exports = {
  db,
  isConnected: () => db !== null,
  initSchema
};
