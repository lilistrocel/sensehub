const bcrypt = require('bcryptjs');
const hash = '$2a$10$of0tnK6ebuOnzX.ysikJbu7BFkHyAU7vayh153oR9ZOMG5id6c7za';
const result = bcrypt.compareSync('admin123', hash);
console.log('Password match:', result);
