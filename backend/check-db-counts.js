const Database = require('better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');

console.log('Equipment count:', db.prepare('SELECT COUNT(*) as count FROM equipment').get().count);
console.log('Zone count:', db.prepare('SELECT COUNT(*) as count FROM zones').get().count);
console.log('User count:', db.prepare('SELECT COUNT(*) as count FROM users').get().count);
console.log('Session count:', db.prepare('SELECT COUNT(*) as count FROM sessions').get().count);

db.close();
