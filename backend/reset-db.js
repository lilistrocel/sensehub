const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'sensehub.db');
const db = new Database(dbPath);

// Clear users and sessions for fresh setup test
db.prepare('DELETE FROM sessions').run();
db.prepare('DELETE FROM users').run();

console.log('Database reset - users and sessions cleared');
console.log('Setup wizard should now be triggered');

db.close();
