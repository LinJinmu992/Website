import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const exists = (path) => access(path).then(() => true, () => false);
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const safeError = (value) => String(value ?? '').trim().slice(-4096);

export const getContentGitConfig = ({ env = process.env, root = process.cwd() } = {}) => ({
	enabled: env.CONTENT_GIT_ENABLED === 'true',
	repository: String(env.CONTENT_GIT_REPOSITORY ?? '').trim(),
	branch: String(env.CONTENT_GIT_BRANCH ?? 'main').trim(),
	sshKeyPath: String(env.CONTENT_GIT_SSH_KEY_PATH ?? '').trim(),
	authorName: String(env.CONTENT_GIT_AUTHOR_NAME ?? 'LinJinmu').trim(),
	authorEmail: String(env.CONTENT_GIT_AUTHOR_EMAIL ?? '').trim(),
	worktree: resolve(root, String(env.CONTENT_GIT_WORKTREE ?? 'server/data/content-repository').trim()),
});

export const validateContentGitConfig = (config, { allowLocalRepository = false } = {}) => {
	if (!config.enabled) return config;
	if (!config.repository || !config.branch || !config.authorName || !config.authorEmail) {
		throw new Error('私有文章仓库配置不完整');
	}
	const isSshRepository = config.repository.startsWith('git@') || config.repository.startsWith('ssh://');
	if (!isSshRepository && !allowLocalRepository) {
		throw new Error('CONTENT_GIT_REPOSITORY 必须使用 SSH 地址');
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(config.branch) || config.branch.includes('..')) {
		throw new Error('CONTENT_GIT_BRANCH 无效');
	}
	if (isSshRepository) {
		if (!config.sshKeyPath || !isAbsolute(config.sshKeyPath) || /[\r\n"]/u.test(config.sshKeyPath)) {
			throw new Error('CONTENT_GIT_SSH_KEY_PATH 必须是安全的绝对路径');
		}
	}
	if (!isAbsolute(config.worktree)) throw new Error('CONTENT_GIT_WORKTREE 必须是绝对路径');
	return config;
};

const sshCommandFor = (config) => {
	if (!config.sshKeyPath) return null;
	const keyPath = config.sshKeyPath.replaceAll('\\', '/');
	return `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
};

export const runGit = (args, {
	cwd,
	config,
	timeoutMs = 30_000,
	allowExitCodes = [0],
} = {}) => new Promise((resolveRun, reject) => {
	const sshCommand = config ? sshCommandFor(config) : null;
	const child = spawn('git', args, {
		cwd,
		shell: false,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
			...(sshCommand ? { GIT_SSH_COMMAND: sshCommand } : {}),
		},
		windowsHide: true,
	});
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-16_384); });
	child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
	child.once('error', (error) => {
		clearTimeout(timeout);
		reject(error);
	});
	child.once('close', (code) => {
		clearTimeout(timeout);
		if (allowExitCodes.includes(code)) {
			resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() });
			return;
		}
		const detail = safeError(stderr || stdout);
		reject(new Error(timedOut ? 'Git 操作超时' : (detail || `Git 操作失败，退出码 ${code}`)));
	});
});

const listMarkdown = async (directory) => {
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error?.code === 'ENOENT') return [];
		throw error;
	}
};

export class ContentGit {
	constructor({ config, postsDir, allowLocalRepository = false }) {
		this.config = validateContentGitConfig(config, { allowLocalRepository });
		this.postsDir = resolve(postsDir);
		this.allowLocalRepository = allowLocalRepository;
	}

	publicStatus() {
		const { enabled, repository, branch, sshKeyPath, authorName, authorEmail, worktree } = this.config;
		return {
			enabled,
			configured: Boolean(repository && branch && authorName && authorEmail && (sshKeyPath || this.allowLocalRepository)),
			repository: repository || null,
			branch,
			keyConfigured: Boolean(sshKeyPath),
			authorConfigured: Boolean(authorName && authorEmail),
			worktree,
		};
	}

	async testConnection() {
		validateContentGitConfig({ ...this.config, enabled: true }, { allowLocalRepository: this.allowLocalRepository });
		if (this.config.sshKeyPath) await access(this.config.sshKeyPath);
		await runGit(['ls-remote', this.config.repository], {
			cwd: dirname(this.config.worktree),
			config: this.config,
		});
		return this.publicStatus();
	}

	async ensureWorktree() {
		const gitDir = resolve(this.config.worktree, '.git');
		if (!(await exists(gitDir))) {
			await mkdir(dirname(this.config.worktree), { recursive: true });
			if (await exists(this.config.worktree)) {
				const entries = await readdir(this.config.worktree);
				if (entries.length) throw new Error('私有文章仓库工作目录已存在且不是 Git 仓库');
				await rm(this.config.worktree, { recursive: true, force: true });
			}
			await runGit(['clone', this.config.repository, this.config.worktree], {
				cwd: dirname(this.config.worktree),
				config: this.config,
				timeoutMs: 60_000,
			});
		}

		await runGit(['config', 'user.name', this.config.authorName], { cwd: this.config.worktree, config: this.config });
		await runGit(['config', 'user.email', this.config.authorEmail], { cwd: this.config.worktree, config: this.config });
		await runGit(['remote', 'set-url', 'origin', this.config.repository], { cwd: this.config.worktree, config: this.config });
		return this.config.worktree;
	}

	async remoteBranchExists() {
		const result = await runGit([
			'ls-remote', '--heads', this.config.repository, `refs/heads/${this.config.branch}`,
		], { cwd: this.config.worktree, config: this.config });
		return Boolean(result.stdout);
	}

	async prepareBranch() {
		await this.ensureWorktree();
		const remoteExists = await this.remoteBranchExists();
		if (remoteExists) {
			await runGit(['fetch', 'origin', this.config.branch], {
				cwd: this.config.worktree,
				config: this.config,
				timeoutMs: 60_000,
			});
			const localBranch = await runGit(['rev-parse', '--verify', this.config.branch], {
				cwd: this.config.worktree,
				config: this.config,
				allowExitCodes: [0, 128],
			});
			if (localBranch.code === 0) {
				await runGit(['checkout', this.config.branch], { cwd: this.config.worktree, config: this.config });
				await runGit(['pull', '--rebase', 'origin', this.config.branch], {
					cwd: this.config.worktree,
					config: this.config,
					timeoutMs: 60_000,
				});
			} else {
				await runGit(['checkout', '-B', this.config.branch, `origin/${this.config.branch}`], {
					cwd: this.config.worktree,
					config: this.config,
				});
			}
		} else {
			await runGit(['checkout', '-B', this.config.branch], { cwd: this.config.worktree, config: this.config });
		}
		return remoteExists;
	}

	async writeSnapshot() {
		const targetDir = resolve(this.config.worktree, 'posts');
		await rm(targetDir, { recursive: true, force: true });
		await mkdir(targetDir, { recursive: true });
		const files = await listMarkdown(this.postsDir);
		for (const filename of files) {
			await copyFile(resolve(this.postsDir, filename), resolve(targetDir, filename));
		}
		await writeFile(resolve(targetDir, '.gitkeep'), '', 'utf8');
		return files.length;
	}

	async pushSnapshot(message = 'Sync blog posts') {
		if (!this.config.enabled) return { enabled: false, synced: false, changed: false };
		let lastError;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				return await this.pushSnapshotOnce(message);
			} catch (error) {
				lastError = error;
				if (attempt < 2) await wait(750);
			}
		}
		throw lastError;
	}

	async pushSnapshotOnce(message) {
		await this.prepareBranch();
		const postCount = await this.writeSnapshot();
		await runGit(['add', '--all', '--', 'posts'], { cwd: this.config.worktree, config: this.config });
		const diff = await runGit(['diff', '--cached', '--quiet'], {
			cwd: this.config.worktree,
			config: this.config,
			allowExitCodes: [0, 1],
		});
		const changed = diff.code === 1;
		if (changed) {
			await runGit(['commit', '-m', message], { cwd: this.config.worktree, config: this.config });
		}

		await runGit(['push', 'origin', `HEAD:refs/heads/${this.config.branch}`], {
			cwd: this.config.worktree,
			config: this.config,
			timeoutMs: 60_000,
		});
		const commit = await runGit(['rev-parse', 'HEAD'], { cwd: this.config.worktree, config: this.config });
		return { enabled: true, synced: true, changed, postCount, commit: commit.stdout };
	}

	async restoreSnapshot() {
		if (!this.config.enabled) throw new Error('私有文章仓库同步尚未启用');
		await this.prepareBranch();
		const sourceDir = resolve(this.config.worktree, 'posts');
		const files = await listMarkdown(sourceDir);
		const stagedDir = resolve(dirname(this.postsDir), `.posts-restore-${Date.now()}`);
		const previousDir = resolve(dirname(this.postsDir), `.posts-previous-${Date.now()}`);
		await mkdir(stagedDir, { recursive: true });
		for (const filename of files) {
			await copyFile(resolve(sourceDir, filename), resolve(stagedDir, filename));
		}
		await writeFile(resolve(stagedDir, '.gitkeep'), '', 'utf8');
		let movedPrevious = false;
		try {
			if (await exists(this.postsDir)) {
				await rename(this.postsDir, previousDir);
				movedPrevious = true;
			}
			await rename(stagedDir, this.postsDir);
			await rm(previousDir, { recursive: true, force: true });
		} catch (error) {
			await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
			if (movedPrevious && !(await exists(this.postsDir))) await rename(previousDir, this.postsDir);
			throw error;
		}
		return { restored: true, postCount: files.length };
	}
}
