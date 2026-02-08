const Database = require('better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

// Count total equipment
const total = db.prepare('SELECT COUNT(*) as count FROM equipment WHERE enabled = 1').get();
console.log('Total enabled equipment:', total.count);

// Count by status
const byStatus = db.prepare(`
  SELECT status, COUNT(*) as count
  FROM equipment
  WHERE enabled = 1
  GROUP BY status
`).all();
console.log('Equipment by status:', byStatus);

// List all equipment with status
const all = db.prepare('SELECT id, name, status, enabled FROM equipment').all();
console.log('All equipment:', all);

db.close();
