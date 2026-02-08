const bcrypt = require('./backend/node_modules/bcryptjs');

const hash = '$2a$10$Qbn/fbVlmBX4jUB4mzEU0OYFMVnI8V48WRI6s8U1PFtbTRr8QnTnC';
const password = 'admin123';

const match = bcrypt.compareSync(password, hash);
process.stdout.write('Password match: ' + match + '\n');

// Generate new hash
const newHash = bcrypt.hashSync('admin123', 10);
process.stdout.write('New hash: ' + newHash + '\n');
process.stdout.write('New hash match: ' + bcrypt.compareSync('admin123', newHash) + '\n');
