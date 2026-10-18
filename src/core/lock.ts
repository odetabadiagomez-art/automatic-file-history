import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LockOptions {
	lockPath: string;
	/** How long to wait for another window before giving up. */
	acquireTimeoutMs?: number;
	/** A lock older than this is considered abandoned. */
	staleAfterMs?: number;
	/** Base delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Injectable for tests. */
	now?: () => number;
}

interface LockPayload {
	pid: number;
	hostname: string;
	token: string;
	startedAt: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Cross-window advisory lock plus an in-process mutex.
 *
 * Every mutation of a manifest runs inside {@link runExclusive}, which means a
 * window always re-reads the newest on-disk state before writing. That is what
 * keeps two VS Code windows on the same workspace from losing each other's
 * revisions. It is an advisory lock: it coordinates cooperating processes only.
 */
export class WorkspaceLock {
	private readonly acquireTimeoutMs: number;
	private readonly staleAfterMs: number;
	private readonly retryDelayMs: number;
	private readonly now: () => number;
	private readonly token = randomBytes(8).toString('hex');
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: LockOptions) {
		this.acquireTimeoutMs = options.acquireTimeoutMs ?? 10_000;
		this.staleAfterMs = options.staleAfterMs ?? 30_000;
		this.retryDelayMs = options.retryDelayMs ?? 20;
		this.now = options.now ?? Date.now;
	}

	/** Serialize `fn` against every other window and every other call here. */
	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			await this.acquire();
			try {
				return await fn();
			} finally {
				await this.release();
			}
		};
		const result = this.queue.then(run, run);
		// Keep the chain alive even when a task rejects.
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private async acquire(): Promise<void> {
		const { lockPath } = this.options;
		await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
		const deadline = this.now() + this.acquireTimeoutMs;
		const payload: LockPayload = {
			pid: process.pid,
			hostname: os.hostname(),
			token: this.token,
			startedAt: new Date(this.now()).toISOString()
		};

		for (let attempt = 0; ; attempt++) {
			try {
				const handle = await fs.open(lockPath, 'wx', 0o600);
				try {
					await handle.writeFile(JSON.stringify(payload), 'utf8');
					await handle.sync();
				} finally {
					await handle.close();
				}
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST') {
					throw err;
				}
			}

			if (await this.reclaimIfAbandoned(deadline)) {
				continue;
			}
			if (this.now() >= deadline) {
				throw new Error(
					`Timed out after ${this.acquireTimeoutMs} ms waiting for another VS Code window to release the history lock.`
				);
			}
			// Small jitter keeps two windows from retrying in lockstep.
			await sleep(this.retryDelayMs + Math.floor(Math.random() * this.retryDelayMs));
			if (attempt > 10_000) {
				throw new Error('History lock acquisition loop exceeded its iteration bound.');
			}
		}
	}

	/** True when the caller should immediately retry creation. */
	private async reclaimIfAbandoned(deadline: number): Promise<boolean> {
		const { lockPath } = this.options;
		let raw: string;
		try {
			raw = await fs.readFile(lockPath, 'utf8');
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return true;
			}
			return false;
		}

		let abandoned = false;
		try {
			const info = JSON.parse(raw) as LockPayload;
			const startedAt = Date.parse(info.startedAt);
			const age = Number.isFinite(startedAt) ? this.now() - startedAt : Number.POSITIVE_INFINITY;
			const sameHost = info.hostname === os.hostname();
			const holderAlive = sameHost ? isPidAlive(info.pid) : true;
			abandoned = age > this.staleAfterMs || !holderAlive;
		} catch {
			// Unparseable lock file: treat as abandoned rather than deadlock.
			abandoned = true;
		}

		if (!abandoned) {
			return false;
		}
		try {
			await fs.unlink(lockPath);
		} catch {
			// Someone else reclaimed it first; the next create attempt decides.
		}
		void deadline;
		return true;
	}

	private async release(): Promise<void> {
		const { lockPath } = this.options;
		try {
			const raw = await fs.readFile(lockPath, 'utf8');
			const info = JSON.parse(raw) as LockPayload;
			if (info.token !== this.token || info.pid !== process.pid) {
				return;
			}
		} catch {
			return;
		}
		try {
			await fs.unlink(lockPath);
		} catch {
			// Already gone.
		}
	}
}
