const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

const hash = bcrypt.hashSync('viewer123', 10);
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'operator@sensehub.local');
console.log('Updated rows:', result.changes);
