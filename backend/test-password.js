const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database('/home/noobcity/Code/SenseHub/backend/data/sensehub.db');
const user = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('Hash in DB:', user.password_hash);
console.log('Test admin123:', bcrypt.compareSync('admin123', user.password_hash));
db.close();
