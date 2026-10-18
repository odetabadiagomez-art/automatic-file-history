import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	blobRelativePath,
	canonicalPathForIdentity,
	computeFileId,
	sha256Hex
} from './ids';
import { WorkspaceLock } from './lock';
import {
	STORAGE_VERSION,
	type AppendResult,
	type CapturePolicy,
	type FileHistory,
	type FileSummary,
	type Origin,
	type Revision,
	type RevisionEvent,
	type StorageUsage
} from './types';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BLOB_MODE = 0o400;

export interface StoreOptions {
	/** Extension-managed directory for this workspace. Never inside the project. */
	rootDir: string;
	workspaceId: string;
	policy: CapturePolicy;
	now?: () => Date;
	/** Called with human-readable messages; never receives file content. */
	log?: (message: string) => void;
}

export interface AppendContentInput {
	absPath: string;
	relPath: string;
	rootName?: string;
	content: Buffer;
	event: RevisionEvent;
	origin: Origin;
	note?: string;
	/** Source file mtime at capture time, when the caller knows it. */
	mtimeMs?: number;
}

export interface GcResult {
	removedBlobs: number;
	freedBytes: number;
}

export interface BudgetResult {
	prunedRevisions: number;
	freedBytes: number;
	filesTouched: number;
}

/** Best-effort directory fsync so a rename survives a crash. */
async function fsyncDir(dir: string): Promise<void> {
	try {
		const handle = await fs.open(dir, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Not supported on every platform (notably Windows); the rename itself
		// is still atomic.
	}
}

/**
 * Content-addressed snapshot store for one workspace.
 *
 * Layout:
 *   <root>/blobs/<xx>/<sha256>   immutable, deduplicated, 0400
 *   <root>/files/<fileId>.json   per-file revision metadata, atomically replaced
 *   <root>/lock                  cross-window advisory lock
 *
 * Manifests are the only source of truth. There is no separate index to fall out
 * of sync, and an interrupted write leaves either the previous manifest or an
 * unreferenced blob that garbage collection removes.
 */
export class HistoryStore {
	readonly rootDir: string;
	readonly workspaceId: string;
	private readonly filesDir: string;
	private readonly blobsDir: string;
	private readonly lock: WorkspaceLock;
	private readonly now: () => Date;
	private readonly log: (message: string) => void;
	private policy: CapturePolicy;

	private readonly summaryCache = new Map<string, { mtimeMs: number; size: number; summary: FileSummary }>();
	private usageCache: { at: number; usage: StorageUsage } | undefined;

	private constructor(options: StoreOptions) {
		this.rootDir = options.rootDir;
		this.workspaceId = options.workspaceId;
		this.filesDir = path.join(options.rootDir, 'files');
		this.blobsDir = path.join(options.rootDir, 'blobs');
		this.policy = options.policy;
		this.now = options.now ?? (() => new Date());
		this.log = options.log ?? (() => undefined);
		this.lock = new WorkspaceLock({ lockPath: path.join(options.rootDir, 'lock') });
	}

	static async open(options: StoreOptions): Promise<HistoryStore> {
		const store = new HistoryStore(options);
		await fs.mkdir(store.filesDir, { recursive: true, mode: DIR_MODE });
		await fs.mkdir(store.blobsDir, { recursive: true, mode: DIR_MODE });
		await store.tightenPermissions();
		return store;
	}

	/** Snapshots hold user source code, so keep them owner-only where supported. */
	private async tightenPermissions(): Promise<void> {
		for (const dir of [this.rootDir, this.filesDir, this.blobsDir]) {
			await fs.chmod(dir, DIR_MODE).catch(() => undefined);
		}
	}

	setPolicy(policy: CapturePolicy): void {
		this.policy = policy;
		this.usageCache = undefined;
	}

	get currentPolicy(): CapturePolicy {
		return this.policy;
	}

	fileIdFor(absPath: string): string {
		return computeFileId(this.workspaceId, absPath);
	}

	private manifestPath(fileId: string): string {
		return path.join(this.filesDir, `${fileId}.json`);
	}

	private blobAbsPath(relative: string): string {
		return path.join(this.rootDir, relative);
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	// ---------------------------------------------------------------- blobs

	/**
	 * Persist content as an immutable blob and return its relative path.
	 * Called before any manifest references it, so a crash can only leave an
	 * orphan blob, never a dangling reference.
	 */
	async writeBlob(content: Buffer): Promise<{ relative: string; hash: string }> {
		const hash = sha256Hex(content);
		const relative = blobRelativePath(hash);
		const target = this.blobAbsPath(relative);

		try {
			const stat = await fs.stat(target);
			if (stat.size === content.length) {
				return { relative, hash };
			}
		} catch {
			// Missing: write it below.
		}

		await fs.mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
		const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(tmp, 'w', FILE_MODE);
			await handle.writeFile(content);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await fs.chmod(tmp, BLOB_MODE).catch(() => undefined);
			await fs.rename(tmp, target);
			await fsyncDir(path.dirname(target));
		} catch (err) {
			if (handle) {
				await handle.close().catch(() => undefined);
			}
			await fs.unlink(tmp).catch(() => undefined);
			throw err;
		}
		return { relative, hash };
	}

	/** Read a blob and verify its hash. Throws when content is missing or wrong. */
	async readBlob(hash: string): Promise<Buffer> {
		if (!/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error(`Refusing to read blob with invalid hash "${hash}".`);
		}
		const target = this.blobAbsPath(blobRelativePath(hash));
		const content = await fs.readFile(target);
		const actual = sha256Hex(content);
		if (actual !== hash) {
			throw new Error(
				`Stored snapshot failed integrity check (expected ${hash.slice(0, 12)}…, found ${actual.slice(0, 12)}…).`
			);
		}
		return content;
	}

	async hasBlob(hash: string): Promise<boolean> {
		try {
			await fs.access(this.blobAbsPath(blobRelativePath(hash)));
			return true;
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------ manifests

	private async readManifest(fileId: string): Promise<FileHistory | null> {
		try {
			const raw = await fs.readFile(this.manifestPath(fileId), 'utf8');
			const parsed = JSON.parse(raw) as FileHistory;
			if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.revisions)) {
				this.log(`Ignoring unreadable history record for ${fileId}.`);
				return null;
			}
			return parsed;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT') {
				this.log(`Could not read history record for ${fileId}: ${code ?? 'unknown error'}`);
			}
			return null;
		}
	}

	private async writeManifest(history: FileHistory): Promise<void> {
		const target = this.manifestPath(history.fileId);
		const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(tmp, 'w', FILE_MODE);
			await handle.writeFile(JSON.stringify(history));
			await handle.sync();
			await handle.close();
			handle = undefined;
			await fs.rename(tmp, target);
			await fsyncDir(this.filesDir);
			this.summaryCache.delete(history.fileId);
			this.usageCache = undefined;
		} catch (err) {
			if (handle) {
				await handle.close().catch(() => undefined);
			}
			await fs.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private newHistory(input: {
		fileId: string;
		absPath: string;
		relPath: string;
		rootName?: string;
	}): FileHistory {
		const at = this.timestamp();
		return {
			version: STORAGE_VERSION,
			fileId: input.fileId,
			workspaceId: this.workspaceId,
			path: input.absPath,
			relPath: input.relPath,
			rootName: input.rootName,
			createdAt: at,
			updatedAt: at,
			nextSeq: 1,
			revisions: []
		};
	}

	async getFileHistory(fileId: string): Promise<FileHistory | null> {
		return this.readManifest(fileId);
	}

	async getHistoryByPath(absPath: string): Promise<FileHistory | null> {
		return this.readManifest(this.fileIdFor(absPath));
	}

	async latestRevision(fileId: string): Promise<Revision | undefined> {
		const history = await this.readManifest(fileId);
		return history?.revisions[history.revisions.length - 1];
	}

	// -------------------------------------------------------------- appends

	/**
	 * Publish one observed state. Identical consecutive content is not stored
	 * twice; returning to an older state is stored as a new revision.
	 */
	async appendContent(input: AppendContentInput): Promise<AppendResult> {
		const { relative, hash } = await this.writeBlob(input.content);
		const fileId = this.fileIdFor(input.absPath);

		return this.lock.runExclusive(async () => {
			// A concurrent garbage collection could have removed the blob between
			// the write above and this lock; re-materialise it if so.
			if (!(await this.hasBlob(hash))) {
				const rewritten = await this.writeBlob(input.content);
				if (rewritten.hash !== hash) {
					throw new Error('Snapshot content changed while it was being stored.');
				}
			}

			const at = this.timestamp();
			const history =
				(await this.readManifest(fileId)) ??
				this.newHistory({
					fileId,
					absPath: input.absPath,
					relPath: input.relPath,
					rootName: input.rootName
				});

			const latest = history.revisions[history.revisions.length - 1];
			if (latest && latest.hash === hash) {
				return {
					kind: 'unchanged',
					fileId,
					seq: latest.seq,
					hash,
					size: input.content.length,
					event: latest.event
				};
			}

			const revision: Revision = {
				seq: history.nextSeq++,
				hash,
				size: input.content.length,
				mtimeMs: input.mtimeMs,
				observedAt: at,
				event: input.event,
				origin: input.origin,
				blob: relative,
				note: input.note
			};
			history.revisions.push(revision);
			history.path = input.absPath;
			history.relPath = input.relPath;
			history.rootName = input.rootName ?? history.rootName;
			history.updatedAt = at;
			history.deleted = false;

			const pruned = this.applyRetention(history);
			await this.writeManifest(history);

			await this.enforceBudgetIfOver();

			return {
				kind: 'captured',
				fileId,
				seq: revision.seq,
				hash,
				size: revision.size,
				event: revision.event,
				pruned
			};
		});
	}

	/**
	 * Record that the file disappeared. Previous snapshots stay readable, which
	 * is what makes a deleted file recoverable.
	 */
	async markDeleted(input: {
		absPath: string;
		relPath: string;
		rootName?: string;
		note?: string;
	}): Promise<AppendResult> {
		const fileId = this.fileIdFor(input.absPath);
		return this.lock.runExclusive(async () => {
			const at = this.timestamp();
			const history = await this.readManifest(fileId);
			if (!history) {
				// Nothing was ever captured for this path, so there is nothing to
				// preserve. Report it instead of inventing a record.
				return { kind: 'unchanged', fileId };
			}
			const latest = history.revisions[history.revisions.length - 1];
			if (latest && latest.event === 'deleted') {
				history.deleted = true;
				history.path = input.absPath;
				history.relPath = input.relPath;
				await this.writeManifest(history);
				return { kind: 'unchanged', fileId, seq: latest.seq, event: 'deleted' };
			}

			const revision: Revision = {
				seq: history.nextSeq++,
				hash: '',
				size: 0,
				observedAt: at,
				event: 'deleted',
				origin: 'unknown',
				note: input.note
			};
			history.revisions.push(revision);
			history.path = input.absPath;
			history.relPath = input.relPath;
			history.rootName = input.rootName ?? history.rootName;
			history.updatedAt = at;
			history.deleted = true;

			const pruned = this.applyRetention(history);
			await this.writeManifest(history);
			return { kind: 'deleted', fileId, seq: revision.seq, event: 'deleted', pruned };
		});
	}

	/**
	 * Move history to a new path after a rename that VS Code told us about.
	 * Returns false when there is no history to move, or when the destination
	 * already has its own history - in both cases nothing is guessed or merged.
	 */
	async recordRename(fromAbsPath: string, toAbsPath: string, toRelPath: string, rootName?: string): Promise<boolean> {
		const fromId = this.fileIdFor(fromAbsPath);
		const toId = this.fileIdFor(toAbsPath);

		return this.lock.runExclusive(async () => {
			const history = await this.readManifest(fromId);
			if (!history) {
				return false;
			}
			if (toId !== fromId) {
				const existing = await this.readManifest(toId);
				if (existing) {
					return false;
				}
				history.renamedFrom = [...(history.renamedFrom ?? []), history.path];
				history.fileId = toId;
				await fs.unlink(this.manifestPath(fromId)).catch(() => undefined);
				this.summaryCache.delete(fromId);
			}
			history.path = toAbsPath;
			history.relPath = toRelPath;
			history.rootName = rootName ?? history.rootName;
			history.updatedAt = this.timestamp();
			await this.writeManifest(history);
			return true;
		});
	}

	// ----------------------------------------------------------- retention

	/**
	 * Keep the newest revisions plus the first captured state, so the promised
	 * baseline survives churn. Returns the number of revisions removed.
	 */
	private applyRetention(history: FileHistory): number {
		const max = Math.max(2, Math.floor(this.policy.maxRevisionsPerFile));
		if (history.revisions.length <= max) {
			return 0;
		}
		const keep = new Set<number>([0]);
		for (let i = history.revisions.length - (max - 1); i < history.revisions.length; i++) {
			keep.add(i);
		}
		const removed = history.revisions.filter((_, index) => !keep.has(index)).length;
		history.revisions = history.revisions.filter((_, index) => keep.has(index));
		history.pruned = (history.pruned ?? 0) + removed;
		return removed;
	}

	private async enforceBudgetIfOver(): Promise<void> {
		const usage = await this.usage();
		if (usage.blobBytes <= this.policy.workspaceBudgetBytes) {
			return;
		}
		try {
			// Already inside the lock: use the unlocked bodies to avoid deadlocking.
			await this.enforceBudgetUnlocked();
			await this.gcUnlocked(0);
		} catch (err) {
			this.log(`Could not apply the workspace history budget: ${(err as Error).message}`);
		}
	}

	/**
	 * Prune the oldest revisions across the workspace until the blob budget is
	 * respected. Each file keeps its first captured state and its latest state.
	 */
	async enforceBudget(): Promise<BudgetResult> {
		return this.lock.runExclusive(() => this.enforceBudgetUnlocked());
	}

	/** Caller must already hold the workspace lock. */
	private async enforceBudgetUnlocked(): Promise<BudgetResult> {
		{
			const histories = await this.readAllHistories();
			const blobBytes = await this.measureBlobBytes();
			const budget = this.policy.workspaceBudgetBytes;
			if (blobBytes <= budget) {
				return { prunedRevisions: 0, freedBytes: 0, filesTouched: 0 };
			}

			const refCounts = new Map<string, number>();
			for (const history of histories) {
				for (const revision of history.revisions) {
					if (revision.hash) {
						refCounts.set(revision.hash, (refCounts.get(revision.hash) ?? 0) + 1);
					}
				}
			}

			interface Candidate {
				history: FileHistory;
				index: number;
				revision: Revision;
			}
			const candidates: Candidate[] = [];
			histories.forEach(history => {
				history.revisions.forEach((revision, index) => {
					const isLast = index === history.revisions.length - 1;
					const isBaseline = index === 0;
					if (!isLast && !isBaseline && revision.hash) {
						candidates.push({ history, index, revision });
					}
				});
			});
			candidates.sort((a, b) => {
				const byTime = Date.parse(a.revision.observedAt) - Date.parse(b.revision.observedAt);
				return byTime !== 0 ? byTime : a.revision.seq - b.revision.seq;
			});

			const removeByFile = new Map<string, Set<number>>();
			let projected = blobBytes;
			let pruned = 0;

			for (const candidate of candidates) {
				if (projected <= budget) {
					break;
				}
				const count = refCounts.get(candidate.revision.hash) ?? 0;
				refCounts.set(candidate.revision.hash, count - 1);
				if (count - 1 <= 0) {
					projected -= candidate.revision.size;
				}
				const set = removeByFile.get(candidate.history.fileId) ?? new Set<number>();
				set.add(candidate.index);
				removeByFile.set(candidate.history.fileId, set);
				pruned++;
			}

			let freedBytes = blobBytes - projected;
			let filesTouched = 0;
			for (const history of histories) {
				const removals = removeByFile.get(history.fileId);
				if (!removals || removals.size === 0) {
					continue;
				}
				history.revisions = history.revisions.filter((_, index) => !removals.has(index));
				history.pruned = (history.pruned ?? 0) + removals.size;
				history.updatedAt = this.timestamp();
				await this.writeManifest(history);
				filesTouched++;
			}
			if (freedBytes < 0) {
				freedBytes = 0;
			}
			return { prunedRevisions: pruned, freedBytes, filesTouched };
		}
	}

	/**
	 * Delete blobs that no manifest references. Freshly written blobs are kept
	 * for a grace period so a concurrent capture that has not published its
	 * manifest yet is never stranded.
	 */
	async gc(options: { graceMs?: number } = {}): Promise<GcResult> {
		return this.lock.runExclusive(() => this.gcUnlocked(options.graceMs ?? 120_000));
	}

	/** Caller must already hold the workspace lock. */
	private async gcUnlocked(graceMs: number): Promise<GcResult> {
		{
			const referenced = new Set<string>();
			for (const history of await this.readAllHistories()) {
				for (const revision of history.revisions) {
					if (revision.hash) {
						referenced.add(revision.hash);
					}
				}
			}

			const cutoff = this.now().getTime() - graceMs;
			let removedBlobs = 0;
			let freedBytes = 0;

			let prefixes: string[];
			try {
				prefixes = await fs.readdir(this.blobsDir);
			} catch {
				return { removedBlobs: 0, freedBytes: 0 };
			}

			for (const prefix of prefixes) {
				const prefixDir = path.join(this.blobsDir, prefix);
				const stat = await fs.stat(prefixDir).catch(() => undefined);
				if (!stat?.isDirectory()) {
					continue;
				}
				for (const entry of await fs.readdir(prefixDir)) {
					const abs = path.join(prefixDir, entry);
					const entryStat = await fs.stat(abs).catch(() => undefined);
					if (!entryStat) {
						continue;
					}
					if (entry.includes('.tmp-')) {
						// Leftover from an interrupted write.
						if (entryStat.mtimeMs < cutoff) {
							await fs.unlink(abs).catch(() => undefined);
							removedBlobs++;
							freedBytes += entryStat.size;
						}
						continue;
					}
					if (referenced.has(entry)) {
						continue;
					}
					if (entryStat.mtimeMs >= cutoff) {
						continue;
					}
					await fs.chmod(abs, FILE_MODE).catch(() => undefined);
					await fs.unlink(abs).catch(() => undefined);
					removedBlobs++;
					freedBytes += entryStat.size;
				}
				const remaining = await fs.readdir(prefixDir).catch(() => ['x']);
				if (remaining.length === 0) {
					await fs.rmdir(prefixDir).catch(() => undefined);
				}
			}

			if (removedBlobs > 0) {
				this.usageCache = undefined;
			}
			return { removedBlobs, freedBytes };
		}
	}

	// --------------------------------------------------------------- reads

	async readAllHistories(): Promise<FileHistory[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.filesDir);
		} catch {
			return [];
		}
		const histories: FileHistory[] = [];
		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}
			const history = await this.readManifest(entry.slice(0, -'.json'.length));
			if (history) {
				histories.push(history);
			}
		}
		return histories;
	}

	/** Compact per-file list for the workspace views, newest activity first. */
	async listSummaries(): Promise<FileSummary[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.filesDir);
		} catch {
			return [];
		}

		const seen = new Set<string>();
		const summaries: FileSummary[] = [];

		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}
			const fileId = entry.slice(0, -'.json'.length);
			seen.add(fileId);
			const abs = path.join(this.filesDir, entry);
			const stat = await fs.stat(abs).catch(() => undefined);
			if (!stat) {
				continue;
			}
			const cached = this.summaryCache.get(fileId);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				summaries.push(cached.summary);
				continue;
			}
			const history = await this.readManifest(fileId);
			if (!history) {
				this.summaryCache.delete(fileId);
				continue;
			}
			const summary = toSummary(history);
			this.summaryCache.set(fileId, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
			summaries.push(summary);
		}

		for (const fileId of [...this.summaryCache.keys()]) {
			if (!seen.has(fileId)) {
				this.summaryCache.delete(fileId);
			}
		}

		summaries.sort((a, b) => {
			const byTime = Date.parse(b.lastObservedAt ?? '') - Date.parse(a.lastObservedAt ?? '');
			return byTime !== 0 ? byTime : a.relPath.localeCompare(b.relPath);
		});
		return summaries;
	}

	async usage(): Promise<StorageUsage> {
		const cached = this.usageCache;
		if (cached && Date.now() - cached.at < 15_000) {
			return cached.usage;
		}
		const summaries = await this.listSummaries();
		const blobs = await this.measureDirBytes(this.blobsDir);
		const manifests = await this.measureDirBytes(this.filesDir);
		const usage: StorageUsage = {
			rootDir: this.rootDir,
			fileCount: summaries.length,
			revisionCount: summaries.reduce((total, s) => total + s.revisionCount, 0),
			prunedRevisions: summaries.reduce((total, s) => total + (s.pruned ?? 0), 0),
			blobCount: blobs.count,
			blobBytes: blobs.bytes,
			manifestBytes: manifests.bytes,
			overBudgetBytes: Math.max(0, blobs.bytes - this.policy.workspaceBudgetBytes)
		};
		this.usageCache = { at: Date.now(), usage };
		return usage;
	}

	private async measureBlobBytes(): Promise<number> {
		const measured = await this.measureDirBytes(this.blobsDir);
		return measured.bytes;
	}

	private async measureDirBytes(dir: string): Promise<{ bytes: number; count: number }> {
		let bytes = 0;
		let count = 0;
		const walk = async (current: string): Promise<void> => {
			let entries;
			try {
				entries = await fs.readdir(current, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = path.join(current, entry.name);
				if (entry.isDirectory()) {
					await walk(abs);
				} else if (entry.isFile()) {
					const stat = await fs.stat(abs).catch(() => undefined);
					if (stat) {
						bytes += stat.size;
						count++;
					}
				}
			}
		};
		await walk(dir);
		return { bytes, count };
	}

	// ------------------------------------------------------------ deletion

	async deleteFileHistory(fileId: string): Promise<{ removedRevisions: number; freedBytes: number }> {
		return this.lock.runExclusive(async () => {
			const history = await this.readManifest(fileId);
			const hashes = new Set((history?.revisions ?? []).map(r => r.hash).filter(Boolean));
			await fs.unlink(this.manifestPath(fileId)).catch(() => undefined);
			this.summaryCache.delete(fileId);
			this.usageCache = undefined;

			// Only delete blobs that no other file references.
			const stillReferenced = new Set<string>();
			for (const other of await this.readAllHistories()) {
				for (const revision of other.revisions) {
					if (revision.hash) {
						stillReferenced.add(revision.hash);
					}
				}
			}
			let freedBytes = 0;
			for (const hash of hashes) {
				if (stillReferenced.has(hash)) {
					continue;
				}
				const abs = this.blobAbsPath(blobRelativePath(hash));
				const stat = await fs.stat(abs).catch(() => undefined);
				if (!stat) {
					continue;
				}
				await fs.chmod(abs, FILE_MODE).catch(() => undefined);
				await fs.unlink(abs).catch(() => undefined);
				freedBytes += stat.size;
			}
			return { removedRevisions: history?.revisions.length ?? 0, freedBytes };
		});
	}

	async deleteHistoryByPath(absPath: string): Promise<{ removedRevisions: number; freedBytes: number }> {
		return this.deleteFileHistory(this.fileIdFor(absPath));
	}

	/** Remove every revision this workspace owns. Irreversible. */
	async clearWorkspace(): Promise<void> {
		await this.lock.runExclusive(async () => {
			await fs.rm(this.filesDir, { recursive: true, force: true });
			await fs.rm(this.blobsDir, { recursive: true, force: true });
			await fs.mkdir(this.filesDir, { recursive: true, mode: DIR_MODE });
			await fs.mkdir(this.blobsDir, { recursive: true, mode: DIR_MODE });
			this.summaryCache.clear();
			this.usageCache = undefined;
		});
	}

	/** True when `absPath` lives inside this store; used to avoid self-capture. */
	isOwnStorage(absPath: string): boolean {
		const storage = canonicalPathForIdentity(this.rootDir);
		const candidate = canonicalPathForIdentity(absPath);
		return candidate === storage || candidate.startsWith(storage + path.sep);
	}
}

function toSummary(history: FileHistory): FileSummary {
	const latest = history.revisions[history.revisions.length - 1];
	return {
		fileId: history.fileId,
		path: history.path,
		relPath: history.relPath,
		rootName: history.rootName,
		revisionCount: history.revisions.length,
		latestSeq: latest?.seq,
		latestHash: latest?.hash || undefined,
		latestEvent: latest?.event,
		lastObservedAt: latest?.observedAt ?? history.updatedAt,
		bytes: uniqueBytes(history),
		deleted: history.deleted === true || latest?.event === 'deleted',
		pruned: history.pruned
	};
}

/** Bytes of the distinct blobs this file references. */
function uniqueBytes(history: FileHistory): number {
	const seen = new Map<string, number>();
	for (const revision of history.revisions) {
		if (revision.hash && !seen.has(revision.hash)) {
			seen.set(revision.hash, revision.size);
		}
	}
	let total = 0;
	for (const size of seen.values()) {
		total += size;
	}
	return total;
}
