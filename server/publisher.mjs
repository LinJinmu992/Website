import { spawn } from 'node:child_process';
import * as fileSystem from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const buildSite = (root, outDir) => new Promise((resolveBuild, reject) => {
	// Invoke Node directly so spaces in paths work without shell interpolation.
	const child = spawn(process.execPath, [resolve(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', outDir], {
		cwd: root,
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
		windowsHide: true,
	});
	let output = '';
	const capture = (chunk) => { output = (output + chunk).slice(-65_536); };
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	child.once('error', reject);
	child.once('close', (code) => {
		if (code === 0) resolveBuild(output);
		else reject(new Error(output || `Build failed with code ${code}`));
	});
});

// Staging and the destination share a parent filesystem, including in Docker.
export const createPublisher = ({ root, distDir = resolve(root, 'dist'), build = (outDir) => buildSite(root, outDir), fs = fileSystem, platform = process.platform }) => async () => {
	const stagingRoot = resolve(dirname(distDir), '.admin-tmp');
	await fs.mkdir(stagingRoot, { recursive: true });
	const transactionDir = await fs.mkdtemp(resolve(stagingRoot, 'build-'));
	const stagedDist = resolve(transactionDir, 'dist');
	const previousDist = resolve(transactionDir, 'previous-dist');
	let previousMoved = false;
	let preserveRecovery = false;

	const rename = async (source, target) => {
		for (let attempt = 1; ; attempt++) {
			try {
				await fs.rename(source, target);
				return;
			} catch (error) {
				if (attempt >= 7 || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
				await new Promise((done) => setTimeout(done, 75 * attempt));
			}
		}
	};

	try {
		const output = await build(stagedDist);
		await fs.access(resolve(stagedDist, 'index.html'));
		try {
			await rename(distDir, previousDist);
			previousMoved = true;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		try {
			try {
				await rename(stagedDist, distDir);
			} catch (error) {
				if (platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
				await fs.cp(stagedDist, distDir, { recursive: true, force: true });
			}
		} catch (publishError) {
			try {
				await fs.rm(distDir, { recursive: true, force: true });
				if (previousMoved) await rename(previousDist, distDir);
			} catch (recoveryError) {
				preserveRecovery = true;
				throw new Error(`发布失败且自动恢复失败；恢复文件保留在 ${transactionDir}`, {
					cause: new AggregateError([publishError, recoveryError]),
				});
			}
			throw publishError;
		}
		return output;
	} finally {
		if (!preserveRecovery) await fs.rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
	}
};
