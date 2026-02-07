const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'sensehub.db');
const db = new Database(dbPath);

// Create test zones
const zones = [
  { name: 'Production Floor', description: 'Main manufacturing area with assembly lines' },
  { name: 'Warehouse A', description: 'Storage facility for raw materials' },
  { name: 'Control Room', description: 'Central monitoring station' }
];

for (const zone of zones) {
  try {
    db.prepare('INSERT INTO zones (name, description) VALUES (?, ?)').run(zone.name, zone.description);
    process.stdout.write('Created zone: ' + zone.name + '\n');
  } catch (e) {
    process.stdout.write('Zone exists or error: ' + zone.name + '\n');
  }
}

db.close();
