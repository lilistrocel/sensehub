const Database = require('better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

// Check if there are readings
const readings = db.prepare('SELECT COUNT(*) as count FROM readings').get();
console.log('Current readings count:', readings.count);

// Get equipment
const equipment = db.prepare('SELECT id, name FROM equipment LIMIT 2').all();
console.log('Equipment:', equipment);

if (equipment.length > 0) {
  const insertReading = db.prepare('INSERT INTO readings (equipment_id, value, unit, timestamp) VALUES (?, ?, ?, ?)');

  // Add readings for past 7 days (every hour)
  for (let i = 0; i < 168; i++) {
    const timestamp = new Date(Date.now() - i * 60 * 60 * 1000).toISOString();
    equipment.forEach((eq, idx) => {
      const value = 20 + Math.random() * 10 + (idx * 5);
      insertReading.run(eq.id, value.toFixed(1), '°C', timestamp);
    });
  }
  console.log('Added test readings for 7 days');
}

// Verify
const newCount = db.prepare('SELECT COUNT(*) as count FROM readings').get();
console.log('New readings count:', newCount.count);

db.close();
