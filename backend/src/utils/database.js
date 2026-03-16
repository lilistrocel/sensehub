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
  db.pragma('foreign_keys = ON');
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
      calibration_offset REAL DEFAULT 0,
      calibration_scale REAL DEFAULT 1,
      slave_id INTEGER,
      polling_interval_ms INTEGER DEFAULT 1000,
      register_mappings TEXT,
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

    -- Cloud sync history table
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT CHECK(sync_type IN ('manual', 'automatic', 'scheduled')) DEFAULT 'manual',
      status TEXT CHECK(status IN ('success', 'partial', 'failed')) DEFAULT 'success',
      items_synced INTEGER DEFAULT 0,
      items_failed INTEGER DEFAULT 0,
      message TEXT,
      triggered_by INTEGER,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Equipment error logs table
    CREATE TABLE IF NOT EXISTS equipment_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      error_type TEXT CHECK(error_type IN ('connection', 'timeout', 'protocol', 'validation', 'hardware', 'other')) DEFAULT 'other',
      message TEXT NOT NULL,
      details TEXT,
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- User preferences table
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      sound_alerts_enabled INTEGER DEFAULT 0,
      sound_volume REAL DEFAULT 0.5,
      alert_sound_critical TEXT DEFAULT 'alarm',
      alert_sound_warning TEXT DEFAULT 'beep',
      alert_sound_info TEXT DEFAULT 'chime',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Cloud suggested programs table
    CREATE TABLE IF NOT EXISTS cloud_suggested_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_config TEXT,
      conditions TEXT,
      actions TEXT,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Device templates table for pre-configured Modbus device profiles
    CREATE TABLE IF NOT EXISTS device_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      description TEXT,
      protocol TEXT DEFAULT 'modbus',
      default_slave_id INTEGER,
      default_polling_interval_ms INTEGER DEFAULT 1000,
      register_mappings TEXT NOT NULL,
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Cameras table
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      stream_url TEXT NOT NULL,
      snapshot_url TEXT,
      username TEXT,
      password TEXT,
      manufacturer TEXT,
      model TEXT,
      ip_address TEXT,
      rtsp_port INTEGER DEFAULT 554,
      http_port INTEGER DEFAULT 80,
      go2rtc_name TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 1,
      status TEXT CHECK(status IN ('online', 'offline', 'error')) DEFAULT 'offline',
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Camera-Zones junction table
    CREATE TABLE IF NOT EXISTS camera_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
      UNIQUE(camera_id, zone_id)
    );

    -- Automation templates table for reusable automation blueprints
    CREATE TABLE IF NOT EXISTS automation_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'General',
      conditions TEXT DEFAULT '[]',
      condition_logic TEXT DEFAULT 'AND',
      actions TEXT DEFAULT '[]',
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Lab readings table for manual nutrient analysis entries
    CREATE TABLE IF NOT EXISTS lab_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_date TEXT NOT NULL,
      nutrient TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT DEFAULT '',
      zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Relay events table — logs every relay on/off transition
    CREATE TABLE IF NOT EXISTS relay_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      state INTEGER NOT NULL,
      source TEXT CHECK(source IN ('manual', 'automation', 'automation_auto_off', 'all_channels')) NOT NULL,
      automation_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL
    );

    -- Fertigation ingredients — predefined dropdown list
    CREATE TABLE IF NOT EXISTS fertigation_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Fertigation mixtures — reusable named recipes
    CREATE TABLE IF NOT EXISTS fertigation_mixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Fertigation mixture items — ingredients in a mixture with parts ratios
    CREATE TABLE IF NOT EXISTS fertigation_mixture_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mixture_id INTEGER NOT NULL,
      ingredient_id INTEGER NOT NULL,
      parts REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE CASCADE,
      FOREIGN KEY (ingredient_id) REFERENCES fertigation_ingredients(id) ON DELETE CASCADE,
      UNIQUE(mixture_id, ingredient_id)
    );

    -- Relay channel config — tags relay channels with dispensing info
    CREATE TABLE IF NOT EXISTS relay_channel_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      ingredient_name TEXT,
      mixture_id INTEGER,
      flow_rate REAL NOT NULL,
      flow_unit TEXT DEFAULT 'L/min',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
      UNIQUE(equipment_id, channel)
    );

    -- Watchdog events — persistent log of all watchdog detections and connectivity changes
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      target TEXT,
      status TEXT NOT NULL,
      message TEXT,
      detail TEXT,
      duration_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_readings_equipment ON readings(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
    CREATE INDEX IF NOT EXISTS idx_readings_equip_time ON readings(equipment_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
    CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON automation_logs(automation_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
    CREATE INDEX IF NOT EXISTS idx_equipment_errors_equipment ON equipment_errors(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_errors_created ON equipment_errors(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);
    CREATE INDEX IF NOT EXISTS idx_cloud_suggested_programs_status ON cloud_suggested_programs(status);
    CREATE INDEX IF NOT EXISTS idx_device_templates_category ON device_templates(category);
    CREATE INDEX IF NOT EXISTS idx_cameras_go2rtc_name ON cameras(go2rtc_name);
    CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status);
    CREATE INDEX IF NOT EXISTS idx_camera_zones_camera ON camera_zones(camera_id);
    CREATE INDEX IF NOT EXISTS idx_camera_zones_zone ON camera_zones(zone_id);
    CREATE INDEX IF NOT EXISTS idx_automation_templates_category ON automation_templates(category);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_nutrient ON lab_readings(nutrient);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_sample_date ON lab_readings(sample_date);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_zone ON lab_readings(zone_id);
    CREATE INDEX IF NOT EXISTS idx_relay_events_equipment ON relay_events(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_relay_events_created ON relay_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_relay_events_equip_channel ON relay_events(equipment_id, channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_relay_channel_config_equipment ON relay_channel_config(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_fertigation_mixture_items_mixture ON fertigation_mixture_items(mixture_id);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_type ON watchdog_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_created ON watchdog_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_target ON watchdog_events(target, created_at);
  `);

  // Add calibration columns to existing equipment table if they don't exist
  try {
    const columns = db.pragma("table_info(equipment)").map(col => col.name);
    if (!columns.includes('calibration_offset')) {
      db.exec('ALTER TABLE equipment ADD COLUMN calibration_offset REAL DEFAULT 0');
      console.log('Added calibration_offset column to equipment table');
    }
    if (!columns.includes('calibration_scale')) {
      db.exec('ALTER TABLE equipment ADD COLUMN calibration_scale REAL DEFAULT 1');
      console.log('Added calibration_scale column to equipment table');
    }
  } catch (err) {
    console.log('Calibration columns already exist or migration skipped');
  }

  // Add condition_logic column to automations table if it doesn't exist
  try {
    const automationColumns = db.pragma("table_info(automations)").map(col => col.name);
    if (!automationColumns.includes('condition_logic')) {
      db.exec("ALTER TABLE automations ADD COLUMN condition_logic TEXT DEFAULT 'AND'");
      console.log('Added condition_logic column to automations table');
    }
  } catch (err) {
    console.log('condition_logic column already exists or migration skipped');
  }

  // Add Modbus configuration columns to equipment table if they don't exist
  try {
    const equipmentColumns = db.pragma("table_info(equipment)").map(col => col.name);
    if (!equipmentColumns.includes('slave_id')) {
      db.exec('ALTER TABLE equipment ADD COLUMN slave_id INTEGER');
      console.log('Added slave_id column to equipment table');
    }
    if (!equipmentColumns.includes('polling_interval_ms')) {
      db.exec('ALTER TABLE equipment ADD COLUMN polling_interval_ms INTEGER DEFAULT 1000');
      console.log('Added polling_interval_ms column to equipment table');
    }
    if (!equipmentColumns.includes('register_mappings')) {
      db.exec('ALTER TABLE equipment ADD COLUMN register_mappings TEXT');
      console.log('Added register_mappings column to equipment table');
    }
  } catch (err) {
    console.log('Modbus columns already exist or migration skipped');
  }

  // Add write_only column to equipment table for devices that don't send Modbus responses
  try {
    const eqCols = db.pragma("table_info(equipment)").map(col => col.name);
    if (!eqCols.includes('write_only')) {
      db.exec('ALTER TABLE equipment ADD COLUMN write_only INTEGER DEFAULT 0');
      console.log('Added write_only column to equipment table');
    }
  } catch (err) {
    console.log('write_only column already exists or migration skipped');
  }

  // Add template_id column to automations table if it doesn't exist
  try {
    const autoCols = db.pragma("table_info(automations)").map(col => col.name);
    if (!autoCols.includes('template_id')) {
      db.exec('ALTER TABLE automations ADD COLUMN template_id INTEGER REFERENCES automation_templates(id) ON DELETE SET NULL');
      console.log('Added template_id column to automations table');
    }
    // Create index after column exists
    db.exec('CREATE INDEX IF NOT EXISTS idx_automations_template_id ON automations(template_id)');
  } catch (err) {
    console.log('template_id column already exists or migration skipped');
  }

  // Add last_watchdog_alert column to automations table
  try {
    const autoCols2 = db.pragma("table_info(automations)").map(col => col.name);
    if (!autoCols2.includes('last_watchdog_alert')) {
      db.exec('ALTER TABLE automations ADD COLUMN last_watchdog_alert TEXT');
      console.log('Added last_watchdog_alert column to automations table');
    }
  } catch (err) {
    console.log('last_watchdog_alert column on automations already exists or migration skipped');
  }

  // Add last_watchdog_alert column to equipment table
  try {
    const eqCols2 = db.pragma("table_info(equipment)").map(col => col.name);
    if (!eqCols2.includes('last_watchdog_alert')) {
      db.exec('ALTER TABLE equipment ADD COLUMN last_watchdog_alert TEXT');
      console.log('Added last_watchdog_alert column to equipment table');
    }
  } catch (err) {
    console.log('last_watchdog_alert column on equipment already exists or migration skipped');
  }

  // Add name column to readings table for multi-metric sensors (e.g., 7-in-1 soil meter)
  try {
    const readingsCols = db.pragma("table_info(readings)").map(col => col.name);
    if (!readingsCols.includes('name')) {
      db.exec("ALTER TABLE readings ADD COLUMN name TEXT");
      console.log('Added name column to readings table');
    }
  } catch (err) {
    console.log('readings name column already exists or migration skipped');
  }

  // Migrate relay_channel_config: add mixture_id and make ingredient_name nullable
  try {
    const rccColInfo = db.pragma("table_info(relay_channel_config)");
    const ingCol = rccColInfo.find(c => c.name === 'ingredient_name');
    // Need migration if ingredient_name is NOT NULL (old schema) or mixture_id is missing
    if ((ingCol && ingCol.notnull === 1) || !rccColInfo.find(c => c.name === 'mixture_id')) {
      // Recreate table with correct schema (ingredient_name nullable, mixture_id added)
      db.exec(`
        ALTER TABLE relay_channel_config RENAME TO relay_channel_config_old;
        CREATE TABLE relay_channel_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          equipment_id INTEGER NOT NULL,
          channel INTEGER NOT NULL,
          ingredient_name TEXT,
          mixture_id INTEGER,
          flow_rate REAL NOT NULL,
          flow_unit TEXT DEFAULT 'L/min',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
          FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
          UNIQUE(equipment_id, channel)
        );
        INSERT INTO relay_channel_config (id, equipment_id, channel, ingredient_name, mixture_id, flow_rate, flow_unit, created_at, updated_at)
          SELECT id, equipment_id, channel, ingredient_name, mixture_id, flow_rate, flow_unit, created_at, updated_at FROM relay_channel_config_old;
        DROP TABLE relay_channel_config_old;
        CREATE INDEX IF NOT EXISTS idx_relay_channel_config_equipment ON relay_channel_config(equipment_id);
      `);
      console.log('Migrated relay_channel_config table (added mixture_id, made ingredient_name nullable)');
    }
  } catch (err) {
    console.log('relay_channel_config migration skipped:', err.message);
  }

  // Seed default fertigation ingredients
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM fertigation_ingredients').get().count;
    if (count === 0) {
      const defaults = ['Water', 'Nutrient A', 'Nutrient B', 'CalMag', 'pH Up', 'pH Down', 'Humic Acid', 'Silica', 'Root Stimulator', 'Bloom Booster'];
      const insert = db.prepare('INSERT OR IGNORE INTO fertigation_ingredients (name) VALUES (?)');
      for (const name of defaults) insert.run(name);
      console.log('Seeded default fertigation ingredients');
    }
  } catch (err) {
    console.log('Fertigation ingredients seed skipped:', err.message);
  }

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
