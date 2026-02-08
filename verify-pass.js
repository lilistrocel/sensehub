const bcrypt = require('./backend/node_modules/bcryptjs');
const Database = require('./backend/node_modules/better-sqlite3');
const db = new Database('./backend/data/sensehub.db');
const user = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@sensehub.local');
console.log('User found:', user.email, user.role);
console.log('Hash:', user.password_hash);
const isValid = bcrypt.compareSync('admin123', user.password_hash);
console.log('Password admin123 valid:', isValid);
db.close();
