/**
 * Schema for the MQTT irrigation-monitor ingest (services/MqttIngestService.js).
 *
 * mqtt_monitors     one row per farm id: which equipment row it was provisioned
 *                   as, the last broker status (online/offline LWT), the latest
 *                   retained meta and irrigation/state, and the last error_flags
 *                   value we alerted on. Survives restarts, so provisioning is
 *                   idempotent and a re-delivered retained message is not news.
 * irrigation_cycles one row per (farm_id, cycle_id) from farm/<id>/irrigation/report.
 *                   The report is retained on the broker and re-delivered on every
 *                   (re)subscribe, so the UNIQUE key is what makes ingest idempotent.
 */
const MQTT_INGEST_SQL = `
  CREATE TABLE IF NOT EXISTS mqtt_monitors (
    farm_id TEXT PRIMARY KEY,
    equipment_id INTEGER,
    broker_state TEXT,
    broker_state_at TEXT,
    meta_json TEXT,
    meta_received_at TEXT,
    irrigation_active INTEGER,
    irrigation_since TEXT,
    irrigation_state_ts TEXT,
    last_error_flags INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS irrigation_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id TEXT NOT NULL,
    equipment_id INTEGER,
    cycle_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration_s INTEGER,
    water_m3 REAL,
    dosing_json TEXT NOT NULL,
    raw_payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT,
    UNIQUE (farm_id, cycle_id),
    FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_irrigation_cycles_farm_start ON irrigation_cycles(farm_id, start_time DESC);
  CREATE INDEX IF NOT EXISTS idx_irrigation_cycles_start ON irrigation_cycles(start_time DESC);
`;

function ensureMqttIngestSchema(db) {
  db.exec(MQTT_INGEST_SQL);
}

module.exports = { MQTT_INGEST_SQL, ensureMqttIngestSchema };
