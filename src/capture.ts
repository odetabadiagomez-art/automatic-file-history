import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CaptureEngine } from './core/captureEngine';
import { evaluateEligibility, formatBytes, skipExplanation } from './core/eligibility';
import { canonicalPathForIdentity } from './core/ids';
import { mapWithConcurrency, walkFiles } from './core/scan';
import type { HistoryStore } from './core/store';
import type {
	CaptureOutcome,
	CapturePolicy,
	FileHistory,
	RevisionEvent,
	SkipReason
} from './core/types';
import type { ExtensionSettings } from './config';
import type { MonitorPhase, MonitorStatus } from './status';

/** Upper bound on how many files the startup scan will enumerate. */
export const MAX_SCAN_FILES = 50_000;

export interface FileDescription {
	history: FileHistory | null;
	state: 'history' | 'initializing' | 'skipped' | 'failed' | 'missing' | 'none';
	skipReason?: SkipReason;
	detail: string;
}

export interface MonitorOptions {
	store: HistoryStore;
	/** Extension-managed storage root for this workspace. */
	storageRoot: string;
	getSettings: () => ExtensionSettings;
	onStatus: (status: MonitorStatus) => void;
	/** Called after a state is stored, with the affected absolute path. */
	onHistoryChanged: (absPath: string) => void;
	log: (message: string) => void;
}

interface FolderLocation {
	relPath: string;
	rootName?: string;
}

/**
 * Owns the capture lifecycle for one window: watchers, save hooks, rename
 * handling, the startup baseline scan, and the honest status reported to the UI.
 */
export class FileHistoryMonitor implements vscode.Disposable {
	readonly engine: CaptureEngine;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly watchers: vscode.FileSystemWatcher[] = [];
	private readonly lastOutcomes = new Map<string, CaptureOutcome>();

	private phase: MonitorPhase = 'initializing';
	private phaseDetail: string | undefined;
	private paused = false;
	private counters = { scanned: 0, captured: 0, skipped: 0, failures: 0 };
	private scanActive = false;
	private scanTruncated = false;
	private startupWaiters: Array<() => void> = [];
	private statusTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: MonitorOptions) {
		this.engine = new CaptureEngine({
			store: options.store,
			storageRoot: options.storageRoot,
			policy: options.getSettings().policy,
			onOutcome: outcome => this.handleOutcome(outcome),
			onFailure: outcome =>
				this.options.log(`Capture failed for ${outcome.relPath}: ${outcome.error ?? outcome.reason ?? 'unknown error'}`)
		});
	}

	get currentPhase(): MonitorPhase {
		return this.phase;
	}

	get isScanning(): boolean {
		return this.scanActive;
	}

	/**
	 * Resolve when the startup baseline scan finishes, or false on timeout.
	 * Used by the status UI and by tests that must not assert before a baseline
	 * exists.
	 */
	waitForStartupScan(timeoutMs = 60_000): Promise<boolean> {
		if (!this.scanActive && this.phase !== 'initializing') {
			return Promise.resolve(true);
		}
		return new Promise<boolean>(resolve => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.startupWaiters.push(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	private flushStartupWaiters(): void {
		for (const waiter of this.startupWaiters.splice(0)) {
			waiter();
		}
	}

	get recentFailures(): number {
		return this.counters.failures;
	}

	// ------------------------------------------------------------- lifecycle

	/**
	 * Register watchers first, then discover baselines. Registering first narrows
	 * the window where a change could land between discovery and watching.
	 */
	async start(): Promise<void> {
		this.registerListeners();
		this.registerWatchers();
		this.publishStatus();
		await this.runStartupScan();
	}

	async restart(): Promise<void> {
		this.disposeWatchers();
		this.engine.reset();
		this.lastOutcomes.clear();
		this.counters = { scanned: 0, captured: 0, skipped: 0, failures: 0 };
		await this.start();
	}

	private registerWatchers(): void {
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			// A `**\/*` RelativePattern watcher reports changes to files that are
			// not open in any editor. It still respects `files.watcherExclude`,
			// which the status output reports as a known coverage gap.
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, '**/*')
			);
			this.disposables.push(
				watcher.onDidCreate(uri => this.onWatchEvent(uri, 'created')),
				watcher.onDidChange(uri => this.onWatchEvent(uri, 'disk-change')),
				watcher.onDidDelete(uri => this.onWatchEvent(uri, 'disk-change'))
			);
			this.watchers.push(watcher);
		}
	}

	private registerListeners(): void {
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument(document => {
				if (!this.options.getSettings().captureOnSave) {
					return;
				}
				if (document.uri.scheme !== 'file') {
					return;
				}
				// An editor save is the one trigger whose origin we actually know.
				this.enqueue(document.uri.fsPath, 'editor-save', 'editor');
			}),
			vscode.workspace.onDidRenameFiles(event => {
				void this.onFilesRenamed(event);
			})
		);
	}

	private disposeWatchers(): void {
		for (const watcher of this.watchers.splice(0)) {
			watcher.dispose();
		}
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	dispose(): void {
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
			this.statusTimer = undefined;
		}
		this.disposeWatchers();
		this.engine.reset();
	}

	// -------------------------------------------------------------- controls

	setPaused(paused: boolean): void {
		this.paused = paused;
		this.engine.setPaused(paused);
		if (paused) {
			this.phase = 'paused';
			this.phaseDetail = 'Changes made while paused are not captured and cannot be recovered later.';
		} else if (this.phase === 'paused') {
			this.phase = 'monitoring';
			this.phaseDetail = undefined;
		}
		this.publishStatus();
	}

	setPhase(phase: MonitorPhase, detail?: string): void {
		this.phase = phase;
		this.phaseDetail = detail;
		this.publishStatus();
	}

	applyPolicy(policy: CapturePolicy): void {
		this.engine.setPolicy(policy);
	}

	/** Capture a state now and wait for the acknowledgement. */
	captureNow(absPath: string, event: RevisionEvent = 'checkpoint', note?: string): Promise<CaptureOutcome> {
		const location = this.locate(absPath);
		if (!location) {
			return Promise.resolve({
				kind: 'skipped',
				path: absPath,
				relPath: path.basename(absPath),
				reason: 'The file is not inside a workspace folder.',
				skipReason: 'excluded'
			});
		}
		return this.engine.capture({
			path: absPath,
			relPath: location.relPath,
			rootName: location.rootName,
			event,
			origin: event === 'editor-save' ? 'editor' : 'unknown',
			note
		});
	}

	// -------------------------------------------------------------- watchers

	private onWatchEvent(uri: vscode.Uri, event: RevisionEvent): void {
		if (uri.scheme !== 'file') {
			return;
		}
		const absPath = uri.fsPath;
		if (this.options.store.isOwnStorage(absPath)) {
			return;
		}
		// The watcher cannot identify the writer, so origin stays unknown and the
		// entry is labelled a disk change.
		this.enqueue(absPath, event, 'unknown');
	}

	private enqueue(absPath: string, event: RevisionEvent, origin: 'unknown' | 'editor'): void {
		const location = this.locate(absPath);
		if (!location) {
			return;
		}
		void this.engine
			.capture({
				path: absPath,
				relPath: location.relPath,
				rootName: location.rootName,
				event,
				origin
			})
			.catch(err => this.options.log(`Capture error for ${location.relPath}: ${(err as Error).message}`));
	}

	private async onFilesRenamed(event: vscode.FileRenameEvent): Promise<void> {
		for (const rename of event.files) {
			if (rename.oldUri.scheme !== 'file' || rename.newUri.scheme !== 'file') {
				continue;
			}
			const oldPath = rename.oldUri.fsPath;
			const newPath = rename.newUri.fsPath;
			const stat = await fs.stat(newPath).catch(() => undefined);

			if (stat?.isDirectory()) {
				await this.renameDirectory(oldPath, newPath);
				continue;
			}

			const location = this.locate(newPath);
			if (!location) {
				continue;
			}
			const moved = await this.options.store.recordRename(
				oldPath,
				newPath,
				location.relPath,
				location.rootName
			);
			if (moved) {
				this.options.onHistoryChanged(newPath);
			}
			// Capture the state at the new path so the history has a live anchor.
			this.enqueue(newPath, 'disk-change', 'unknown');
		}
	}

	/**
	 * A folder renamed through VS Code moves every tracked file inside it. Each
	 * record is moved explicitly; nothing is inferred from content similarity.
	 */
	private async renameDirectory(oldDir: string, newDir: string): Promise<void> {
		const prefix = oldDir.endsWith(path.sep) ? oldDir : oldDir + path.sep;
		const summaries = await this.options.store.listSummaries();
		for (const summary of summaries) {
			if (!summary.path.startsWith(prefix)) {
				continue;
			}
			const movedPath = path.join(newDir, summary.path.slice(prefix.length));
			const location = this.locate(movedPath) ?? {
				relPath: path.relative(newDir, movedPath).split(path.sep).join('/'),
				rootName: summary.rootName
			};
			const moved = await this.options.store.recordRename(
				summary.path,
				movedPath,
				location.relPath,
				location.rootName
			);
			if (moved) {
				this.options.onHistoryChanged(movedPath);
			}
		}
	}

	private locate(absPath: string): FolderLocation | undefined {
		const uri = vscode.Uri.file(absPath);
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const relPath = path.relative(folder.uri.fsPath, absPath).split(path.sep).join('/');
		return { relPath, rootName: folder.name };
	}

	// ---------------------------------------------------------- startup scan

	private async runStartupScan(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
		if (folders.length === 0) {
			this.setPhase('unsupported', 'Open a local folder to start capturing history.');
			this.flushStartupWaiters();
			return;
		}

		this.scanActive = true;
		this.scanTruncated = false;
		this.setPhase('initializing', 'Discovering files…');

		const settings = this.options.getSettings();
		const discovered: Array<{ absPath: string; relPath: string; rootName: string }> = [];
		const scannedKeys = new Set<string>();

		try {
			for (const folder of folders) {
				for await (const file of walkFiles({
					rootDir: folder.uri.fsPath,
					policy: settings.policy,
					storageRoot: this.options.storageRoot,
					maxFiles: MAX_SCAN_FILES
				})) {
					if (discovered.length >= MAX_SCAN_FILES) {
						this.scanTruncated = true;
						break;
					}
					discovered.push({
						absPath: file.absPath,
						relPath: file.relPath,
						rootName: folder.name
					});
					scannedKeys.add(canonicalPathForIdentity(file.absPath));
				}
				if (this.scanTruncated) {
					break;
				}
			}

			this.setPhase(
				'initializing',
				`Capturing first snapshots for ${discovered.length} file${discovered.length === 1 ? '' : 's'}…`
			);

			let processed = 0;
			await mapWithConcurrency(
				discovered,
				settings.policy.scanConcurrency,
				async file =>
					this.engine.capture({
						path: file.absPath,
						relPath: file.relPath,
						rootName: file.rootName,
						// Reconciliation labels a first state as a baseline and a
						// divergence from the persisted state as "observed on startup".
						event: 'baseline',
						origin: 'unknown',
						reconcile: true
					}),
				() => {
					processed++;
					this.counters.scanned = processed;
					if (processed % 25 === 0) {
						this.publishStatus({
							message: `Captured first snapshots for ${processed} of ${discovered.length} files…`
						});
					}
				}
			);

			await this.reconcileMissingFiles(scannedKeys);

			this.scanActive = false;
			this.flushStartupWaiters();
			if (this.paused) {
				this.setPhase('paused');
				return;
			}
			const detail = this.scanTruncated
				? `Only the first ${MAX_SCAN_FILES} files were scanned. Files beyond that limit are captured when they change.`
				: undefined;
			this.setPhase('monitoring', detail);
		} catch (err) {
			this.scanActive = false;
			this.flushStartupWaiters();
			this.setPhase('error', `Startup scan failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Files that disappeared while VS Code was closed are marked deleted so they
	 * stay discoverable and restorable. Only paths inside current workspace
	 * folders are considered, and the label says when the deletion was noticed.
	 */
	private async reconcileMissingFiles(scannedKeys: Set<string>): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
		const summaries = await this.options.store.listSummaries();
		const missing = summaries.filter(summary => {
			if (summary.deleted) {
				return false;
			}
			if (scannedKeys.has(canonicalPathForIdentity(summary.path))) {
				return false;
			}
			return folders.some(folder => summary.path.startsWith(folder.uri.fsPath + path.sep));
		});

		for (const summary of missing) {
			const exists = await fs
				.stat(summary.path)
				.then(stat => stat.isFile())
				.catch(() => false);
			if (exists) {
				continue;
			}
			await this.options.store
				.markDeleted({
					absPath: summary.path,
					relPath: summary.relPath,
					rootName: summary.rootName,
					note: 'File was already missing when monitoring started.'
				})
				.catch(err => this.options.log(`Could not record a missing file: ${(err as Error).message}`));
		}
	}

	// -------------------------------------------------------------- outcomes

	private handleOutcome(outcome: CaptureOutcome): void {
		this.lastOutcomes.set(canonicalPathForIdentity(outcome.path), outcome);
		switch (outcome.kind) {
			case 'captured':
				this.counters.captured++;
				this.options.onHistoryChanged(outcome.path);
				break;
			case 'deleted':
				this.counters.captured++;
				this.options.onHistoryChanged(outcome.path);
				break;
			case 'skipped':
				this.counters.skipped++;
				break;
			case 'failed':
				this.counters.failures++;
				this.options.onHistoryChanged(outcome.path);
				if (this.phase === 'monitoring') {
					this.setPhase('error', outcome.error ?? 'A capture failed.');
				}
				break;
			case 'unchanged':
				break;
		}
		this.scheduleStatusRefresh();
	}

	private scheduleStatusRefresh(): void {
		if (this.statusTimer) {
			return;
		}
		this.statusTimer = setTimeout(() => {
			this.statusTimer = undefined;
			// A successful capture after an error returns monitoring to normal,
			// while the failure count stays visible in the status detail.
			if (this.phase === 'error' && this.counters.failures > 0 && !this.scanActive) {
				this.phase = 'monitoring';
				this.phaseDetail = `${this.counters.failures} capture failure(s) since monitoring started.`;
			}
			this.publishStatus();
		}, 1000);
		if (typeof this.statusTimer.unref === 'function') {
			this.statusTimer.unref();
		}
	}

	private publishStatus(extra?: { message?: string }): void {
		const status: MonitorStatus = {
			phase: this.phase,
			message: extra?.message ?? this.phaseDetail,
			detail: this.buildCoverageDetail(),
			scannedFiles: this.counters.scanned,
			capturedStates: this.counters.captured,
			skippedFiles: this.counters.skipped,
			failures: this.counters.failures
		};
		this.options.onStatus(status);
	}

	private buildCoverageDetail(): string {
		const settings = this.options.getSettings();
		const parts: string[] = [];
		parts.push(`Tracking files up to ${formatBytes(settings.policy.maxFileBytes)}.`);
		const excluded = vscode.workspace.getConfiguration('files').get<string[]>('watcherExclude');
		if (excluded && Object.keys(excluded).length > 0) {
			parts.push(
				'VS Code watcher exclusions (files.watcherExclude) also hide those paths from this extension until they are opened or saved.'
			);
		}
		if (this.counters.failures > 0) {
			parts.push(`${this.counters.failures} capture failure(s) since monitoring started.`);
		}
		return parts.join(' ');
	}

	// ------------------------------------------------------ per-file reporting

	/**
	 * Explain, accurately, why a file has no history. The view shows this instead
	 * of a generic empty state.
	 */
	async describeFile(absPath: string): Promise<FileDescription> {
		const history = await this.options.store.getHistoryByPath(absPath);
		if (history && history.revisions.length > 0) {
			return { history, state: 'history', detail: '' };
		}

		const location = this.locate(absPath);
		if (!location) {
			return {
				history,
				state: 'skipped',
				skipReason: 'excluded',
				detail: 'This file is outside the workspace folders, so it is not monitored.'
			};
		}

		const last = this.lastOutcomes.get(canonicalPathForIdentity(absPath));
		if (last?.kind === 'failed') {
			return { history, state: 'failed', detail: last.error ?? 'Capture failed.' };
		}
		if (last?.kind === 'skipped' && last.skipReason) {
			return {
				history,
				state: 'skipped',
				skipReason: last.skipReason,
				detail: last.reason ?? skipExplanation(last.skipReason)
			};
		}

		let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
		try {
			stat = await fs.lstat(absPath);
		} catch {
			return {
				history,
				state: 'missing',
				skipReason: 'missing',
				detail: 'The file no longer exists, and no earlier state was captured.'
			};
		}

		const eligibility = evaluateEligibility({
			absPath,
			relPath: location.relPath,
			size: stat.size,
			isSymbolicLink: stat.isSymbolicLink(),
			isDirectory: stat.isDirectory(),
			storageRoot: this.options.storageRoot,
			policy: this.options.getSettings().policy
		});
		if (!eligibility.eligible) {
			return {
				history,
				state: 'skipped',
				skipReason: eligibility.reason,
				detail: eligibility.detail ?? skipExplanation(eligibility.reason)
			};
		}

		if (this.phase === 'initializing') {
			return {
				history,
				state: 'initializing',
				detail: 'The first snapshots are still being captured. This file will appear when the scan reaches it.'
			};
		}
		return {
			history,
			state: 'none',
			detail: 'No previous state captured yet. The next observed change will be stored.'
		};
	}

	/** Files with recent activity, newest first, for the workspace-level view. */
	async recentlyChanged(limit: number): Promise<import('./core/types').FileSummary[]> {
		const summaries = await this.options.store.listSummaries();
		return summaries.slice(0, Math.max(1, limit));
	}
}
