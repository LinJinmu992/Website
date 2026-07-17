import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const children = new Set();
let stopping = false;

const start = (entry, args = []) => {
	const child = spawn(process.execPath, [resolve(root, entry), ...args], {
		cwd: root,
		stdio: 'inherit',
		env: process.env,
	});
	children.add(child);
	child.once('exit', (code) => {
		children.delete(child);
		if (!stopping) stop(code ?? 1);
	});
	return child;
};

const stop = (code = 0) => {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill();
	setTimeout(() => process.exit(code), 50).unref();
};

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

const isPortOpen = (port) => new Promise((resolvePort) => {
	const socket = createConnection({ host: 'localhost', port });
	const finish = (open) => {
		socket.destroy();
		resolvePort(open);
	};
	socket.setTimeout(500);
	socket.once('connect', () => finish(true));
	socket.once('timeout', () => finish(false));
	socket.once('error', () => finish(false));
});

if (await isPortOpen(4322)) {
	console.log('Admin API is already running on http://127.0.0.1:4322');
} else {
	start('server/admin-server.mjs');
}
if (await isPortOpen(4321)) {
	console.log('Astro is already running on http://localhost:4321');
} else {
	start('node_modules/astro/bin/astro.mjs', ['dev']);
}
