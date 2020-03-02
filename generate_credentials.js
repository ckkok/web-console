const fs = require('fs');
const bcrypt = require('bcryptjs');
const path = require('path');

const username = process.argv[2];
const password = process.argv[3];
const hashedPassword = bcrypt.hashSync(password, Math.ceil(Math.round() * 20) + 10);
const outputFile = path.resolve(__dirname, 'credentials', 'user.json');
const credentials = { username, password: hashedPassword };
fs.writeFileSync(outputFile, JSON.stringify(credentials, null, 2));

console.log(`Generated credentials at ${outputFile}`);
