import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { evaluateEligibility, formatBytes, skipExplanation } from './eligibility';
import { canonicalPathForIdentity } from './ids';
import type { HistoryStore } from './store';
import type {
	CaptureOutcome,
	CapturePolicy,
	CaptureRequest,
	Origin,
	RevisionEvent,
	SkipReason
} from './types';

export interface CaptureEngineOptions {
	store: HistoryStore;
	/** Extension-managed storage root; anything under it is never captured. */
	storageRoot: string;
	policy: CapturePolicy;
	sleep?: (ms: number) => Promise<void>;
	/** Called for every finished pass, including skips and failures. */
	onOutcome?: (outcome: CaptureOutcome) => void;
	/** Called with a short message when a capture fails after its retries. */
	onFailure?: (outcome: CaptureOutcome) => void;
}

interface Waiter {
	request: CaptureRequest;
	resolve: (outcome: CaptureOutcome) => void;
}

interface FileQueue {
	chain: Promise<void>;
	waiters: Waiter[];
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms));

/**
 * Routes every trigger for a file through one serialized queue.
 *
 * Requests that arrive while a pass is running are coalesced into a single
 * follow-up pass, so a burst of writes ends with the latest state captured and
 * an honest acknowledgement for every caller. No caller is told a state was
 * stored when it was not.
 */
export class CaptureEngine {
	private readonly queues = new Map<string, FileQueue>();
	private readonly labelOverrides = new Map<
		string,
		{ event: RevisionEvent; origin: Origin; note?: string }
	>();
	private readonly sleep: (ms: number) => Promise<void>;
	private policy: CapturePolicy;
	private paused = false;

	constructor(private readonly options: CaptureEngineOptions) {
		this.policy = options.policy;
		this.sleep = options.sleep ?? defaultSleep;
	}

	setPolicy(policy: CapturePolicy): void {
		this.policy = policy;
	}

	get currentPolicy(): CapturePolicy {
		return this.policy;
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/** Number of files with an in-flight or queued pass. Used by the status UI. */
	get pendingFileCount(): number {
		let count = 0;
		for (const queue of this.queues.values()) {
			if (queue.waiters.length > 0) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Label the next captured state for `absPath`. Used by restore so the
	 * resulting revision is described as a restore rather than a plain save.
	 */
	setNextCaptureLabel(
		absPath: string,
		label: { event: RevisionEvent; origin: Origin; note?: string }
	): void {
		this.labelOverrides.set(canonicalPathForIdentity(absPath), label);
	}

	clearNextCaptureLabel(absPath: string): void {
		this.labelOverrides.delete(canonicalPathForIdentity(absPath));
	}

	/**
	 * Capture the current state of one file. Resolves when this request has been
	 * accounted for, either by its own pass or by a later pass that observed a
	 * newer state.
	 */
	capture(request: CaptureRequest): Promise<CaptureOutcome> {
		const key = canonicalPathForIdentity(request.path);
		let queue = this.queues.get(key);
		if (!queue) {
			queue = { chain: Promise.resolve(), waiters: [] };
			this.queues.set(key, queue);
		}
		const activeQueue = queue;

		return new Promise<CaptureOutcome>(resolve => {
			activeQueue.waiters.push({ request, resolve });
			activeQueue.chain = activeQueue.chain.then(() => this.runPass(key, activeQueue));
		});
	}

	private async runPass(key: string, queue: FileQueue): Promise<void> {
		const waiters = queue.waiters.splice(0, queue.waiters.length);
		if (waiters.length === 0) {
			return;
		}
		// Newest request wins: it carries the most recent trigger information.
		const request = waiters[waiters.length - 1].request;
		let outcome: CaptureOutcome;
		try {
			outcome = await this.performCapture(key, request);
		} catch (err) {
			outcome = {
				kind: 'failed',
				path: request.path,
				relPath: request.relPath,
				reason: 'Capture failed',
				error: (err as Error).message
			};
		}
		this.options.onOutcome?.(outcome);
		if (outcome.kind === 'failed') {
			this.options.onFailure?.(outcome);
		}
		for (const waiter of waiters) {
			waiter.resolve(outcome);
		}
		if (queue.waiters.length === 0) {
			this.queues.delete(key);
		}
	}

	private async performCapture(key: string, request: CaptureRequest): Promise<CaptureOutcome> {
		const override = this.labelOverrides.get(key);
		if (override) {
			this.labelOverrides.delete(key);
			request = { ...request, ...override };
		}

		const base = { path: request.path, relPath: request.relPath };

		if (this.paused) {
			return { ...base, kind: 'skipped', reason: 'Monitoring is paused', skipReason: 'excluded' };
		}
		if (this.options.store.isOwnStorage(request.path) ||
			canonicalPathForIdentity(request.path).startsWith(
				canonicalPathForIdentity(this.options.storageRoot)
			)) {
			return { ...base, kind: 'skipped', reason: 'Extension storage', skipReason: 'extension-storage' };
		}

		let stat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stat = await fs.lstat(request.path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				return this.recordDeletion(request);
			}
			return this.fail(request, `Could not stat file (${code ?? 'unknown error'})`);
		}

		const precheck = evaluateEligibility({
			absPath: request.path,
			relPath: request.relPath,
			size: stat.size,
			isSymbolicLink: stat.isSymbolicLink(),
			isDirectory: stat.isDirectory(),
			storageRoot: this.options.storageRoot,
			policy: this.policy
		});
		if (!precheck.eligible) {
			return this.skip(request, precheck.reason ?? 'excluded', precheck.detail);
		}

		const stable = await this.waitForStableSize(request.path);
		if (stable.error && !stable.stat) {
			if (stable.notFound) {
				return this.recordDeletion(request);
			}
			return this.fail(request, stable.error);
		}

		// Startup fast path: when the recorded size and mtime both match, the
		// state is treated as already captured without reading the file again.
		// Identity is still decided by content hash whenever they do not match.
		if (request.reconcile && stable.stat) {
			const history = await this.options.store.getHistoryByPath(request.path);
			const latest = history?.revisions[(history?.revisions.length ?? 1) - 1];
			if (
				latest &&
				latest.event !== 'deleted' &&
				latest.size === stable.stat.size &&
				latest.mtimeMs !== undefined &&
				latest.mtimeMs === stable.stat.mtimeMs
			) {
				return {
					kind: 'unchanged',
					path: request.path,
					relPath: request.relPath,
					seq: latest.seq,
					hash: latest.hash,
					size: latest.size,
					event: latest.event
				};
			}
		}

		const content = await this.readWithRetries(request.path, stable.stat?.size);
		if (!content.ok) {
			if (content.notFound) {
				return this.recordDeletion(request);
			}
			return this.fail(request, content.error ?? 'Could not read file');
		}

		const postcheck = evaluateEligibility({
			absPath: request.path,
			relPath: request.relPath,
			size: content.buffer.length,
			isSymbolicLink: false,
			isDirectory: false,
			storageRoot: this.options.storageRoot,
			sample: content.buffer.subarray(0, 8192),
			policy: this.policy
		});
		if (!postcheck.eligible) {
			return this.skip(request, postcheck.reason ?? 'binary', postcheck.detail);
		}

		const event = await this.resolveEvent(request, content.buffer.length);

		try {
			const result = await this.options.store.appendContent({
				absPath: request.path,
				relPath: request.relPath,
				rootName: request.rootName,
				content: content.buffer,
				event: event.event,
				origin: event.origin,
				note: request.note,
				mtimeMs: stable.stat?.mtimeMs
			});
			return {
				kind: result.kind === 'unchanged' ? 'unchanged' : 'captured',
				path: request.path,
				relPath: request.relPath,
				seq: result.seq,
				hash: result.hash,
				size: result.size,
				event: result.event ?? event.event
			};
		} catch (err) {
			return this.fail(request, `Could not store snapshot: ${(err as Error).message}`);
		}
	}

	/**
	 * Decide the label for the state about to be stored. Startup reconciliation
	 * distinguishes a first baseline from a divergence that happened while
	 * monitoring was off; nothing else is inferred.
	 */
	private async resolveEvent(
		request: CaptureRequest,
		size: number
	): Promise<{ event: RevisionEvent; origin: Origin }> {
		void size;
		if (!request.reconcile) {
			return { event: request.event, origin: request.origin };
		}
		const fileId = this.options.store.fileIdFor(request.path);
		const history = await this.options.store.getFileHistory(fileId);
		const latest = history?.revisions[history.revisions.length - 1];
		if (!history || history.revisions.length === 0) {
			return { event: 'baseline', origin: 'unknown' };
		}
		if (latest?.event === 'deleted') {
			return { event: 'created', origin: 'unknown' };
		}
		return { event: 'observed-on-startup', origin: 'unknown' };
	}

	/**
	 * Wait for size and mtime to stop changing. This reduces the chance of
	 * reading a half-written file; it does not prove a writer has finished.
	 */
	private async waitForStableSize(
		absPath: string
	): Promise<{ stat?: Stats; error?: string; notFound?: boolean }> {
		const attempts = Math.max(1, this.policy.stabilizationAttempts);
		const delay = Math.max(0, this.policy.stabilizationDelayMs);
		let previous: Stats | undefined;
		let lastError: string | undefined;

		for (let attempt = 0; attempt < attempts; attempt++) {
			let stat: Stats;
			try {
				stat = await fs.stat(absPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					return { error: 'File disappeared', notFound: true };
				}
				lastError = `Could not stat file (${code ?? 'unknown error'})`;
				await this.sleep(delay);
				continue;
			}
			if (
				previous &&
				previous.size === stat.size &&
				previous.mtimeMs === stat.mtimeMs
			) {
				return { stat };
			}
			previous = stat;
			lastError = undefined;
			if (delay > 0) {
				await this.sleep(delay);
			}
		}
		// Stability was never confirmed. Capture anyway rather than silently
		// dropping the state, and say so in the revision note.
		return { stat: previous, error: lastError };
	}

	private async readWithRetries(
		absPath: string,
		expectedSize: number | undefined
	): Promise<{ ok: true; buffer: Buffer } | { ok: false; error?: string; notFound?: boolean }> {
		const attempts = Math.max(1, this.policy.readRetries + 1);
		let lastError = 'Could not read file';

		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				const buffer = await fs.readFile(absPath);
				if (expectedSize !== undefined && buffer.length !== expectedSize) {
					// The file changed while we were reading it; try once more.
					lastError = `Read ${buffer.length} of ${expectedSize} bytes; the file changed during the read`;
					await this.sleep(Math.max(20, this.policy.stabilizationDelayMs));
					expectedSize = undefined;
					continue;
				}
				if (buffer.length > this.policy.maxFileBytes) {
					return {
						ok: false,
						error: `File grew past the ${formatBytes(this.policy.maxFileBytes)} limit while being read`
					};
				}
				return { ok: true, buffer };
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || code === 'ENOTDIR') {
					return { ok: false, notFound: true };
				}
				lastError = `Could not read file (${code ?? (err as Error).message})`;
				await this.sleep(Math.max(20, this.policy.stabilizationDelayMs));
			}
		}
		return { ok: false, error: lastError };
	}

	private async recordDeletion(request: CaptureRequest): Promise<CaptureOutcome> {
		try {
			const result = await this.options.store.markDeleted({
				absPath: request.path,
				relPath: request.relPath,
				rootName: request.rootName,
				note: request.note
			});
			if (result.kind === 'unchanged' && result.seq === undefined) {
				return {
					kind: 'skipped',
					path: request.path,
					relPath: request.relPath,
					reason: 'No previous state captured',
					skipReason: 'missing'
				};
			}
			return {
				kind: 'deleted',
				path: request.path,
				relPath: request.relPath,
				seq: result.seq,
				event: 'deleted'
			};
		} catch (err) {
			return this.fail(request, `Could not record deletion: ${(err as Error).message}`);
		}
	}

	private skip(request: CaptureRequest, reason: SkipReason, detail?: string): CaptureOutcome {
		return {
			kind: 'skipped',
			path: request.path,
			relPath: request.relPath,
			reason: detail ?? skipExplanation(reason),
			skipReason: reason
		};
	}

	private fail(request: CaptureRequest, error: string): CaptureOutcome {
		return {
			kind: 'failed',
			path: request.path,
			relPath: request.relPath,
			reason: 'Capture failed',
			error
		};
	}

	/** Forget queue state; used after a workspace change. */
	reset(): void {
		this.queues.clear();
		this.labelOverrides.clear();
	}
}
