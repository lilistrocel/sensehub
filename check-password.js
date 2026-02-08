const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');

const user = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('Hash from DB:', user.password_hash);

const result = bcrypt.compareSync('admin123', user.password_hash);
console.log('Password check result:', result);

db.close();
