import { scrypt, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const params = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const rl = createInterface({ input, output });
const password = await rl.question('Admin password: ');
rl.close();

if (!password || password.length < 10) {
	console.error('Password should be at least 10 characters.');
	process.exit(1);
}

const salt = randomBytes(16);
const hash = await scryptAsync(password, salt, 64, params);
const encoded = [
	'scrypt',
	params.N,
	params.r,
	params.p,
	salt.toString('base64url'),
	Buffer.from(hash).toString('base64url'),
].join('$');

console.log('\nADMIN_PASSWORD_HASH=' + encoded);
