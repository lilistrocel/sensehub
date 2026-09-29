/**
 * Schema for the fertigation tank stock countdown (services/TankStockService.js,
 * requirement 2026-09-29: fertigation_tanks.current_stock_liters never decreased,
 * so nobody saw a tank running empty).
 *
 * tank_stock_ledger  every change of a tank's stock, auditable and rebuildable:
 *   kind 'refill'  a fertigation_tank_refills row (ref refill:<id>); stock_after = its level
 *        'adjust'  an operator's manual level correction (ref adjust:<ms>); stock_after = level
 *        'anchor'  a tank that has no refill record yet: counting starts at its stored level
 *        'cycle'   monitor-measured litres of one irrigation cycle (ref cycle:<farm>:<cycle_id>),
 *                  every run type (automated / manual app / manual panel); litres < 0
 *        'acid'    pH Down (not metered): valve open seconds x configured L/min per ON->OFF
 *                  pair of relay events (ref acid:<on relay_event id>), estimated = 1
 *   The level = the latest anchor row's stock_after + the draws after it. UNIQUE(tank_id, ref)
 *   makes re-processing a cycle / relay event an update, never a second count.
 *   occurred_at: ISO 8601 UTC.
 */
const TANK_STOCK_SQL = `
  CREATE TABLE IF NOT EXISTS tank_stock_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    litres REAL NOT NULL DEFAULT 0,
    stock_after REAL,
    estimated INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    UNIQUE (tank_id, ref),
    FOREIGN KEY (tank_id) REFERENCES fertigation_tanks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tank_stock_ledger_tank_time ON tank_stock_ledger(tank_id, occurred_at);
`;

function ensureTankStockSchema(db) {
  db.exec(TANK_STOCK_SQL);
}

module.exports = { ensureTankStockSchema, TANK_STOCK_SQL };
