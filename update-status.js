const Database = require('/home/noobcity/Code/SenseHub/backend/node_modules/better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

// Get all equipment
const allEquipment = db.prepare("SELECT id, name, status FROM equipment ORDER BY id").all();
console.log('Current equipment:');
allEquipment.forEach(r => console.log(`  ID ${r.id}: ${r.name} - ${r.status}`));

// Update first 4 equipment with different statuses
const statuses = ['online', 'offline', 'warning', 'error'];
allEquipment.slice(0, 4).forEach((eq, idx) => {
  const newStatus = statuses[idx];
  db.prepare("UPDATE equipment SET status=? WHERE id=?").run(newStatus, eq.id);
  console.log(`Updated ID ${eq.id} to ${newStatus}`);
});

console.log('\nFinal equipment statuses:');
const results = db.prepare("SELECT id, name, status FROM equipment ORDER BY id").all();
results.forEach(r => console.log(`  ID ${r.id}: ${r.name} - ${r.status}`));

db.close();
