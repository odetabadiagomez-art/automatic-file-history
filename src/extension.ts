import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FileHistoryMonitor, type FileDescription } from './capture';
import { readSettings, workspaceIsSupported, type ExtensionSettings } from './config';
import type { CaptureOutcome, FileHistory, FileSummary } from './core/types';
import { computeWorkspaceId } from './core/ids';
import { HistoryStore } from './core/store';
import { FilesView, FileItem } from './filesView';
import { formatRelative, formatSize, formatTimestamp } from './format';
import { HistoryView, RevisionItem } from './historyView';
import * as recovery from './restore';
import { SNAPSHOT_SCHEME, SnapshotContentProvider, findRevision } from './snapshotProvider';
import { StatusIndicator, type MonitorStatus } from './status';

const OUTPUT_CHANNEL_NAME = 'Automatic File History';

interface Session {
	store: HistoryStore;
	monitor: FileHistoryMonitor;
	historyView: HistoryView;
	filesView: FilesView;
	snapshots: SnapshotContentProvider;
	status: StatusIndicator;
	output: vscode.OutputChannel;
	settings: ExtensionSettings;
}

let session: Session | undefined;
let statusOnly: StatusIndicator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<AutomaticFileHistoryApi> {
	const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(output);
	log(output, `Extension host started for ${describeWorkspace()}`);

	statusOnly = new StatusIndicator();
	context.subscriptions.push(statusOnly);

	registerViewlessCommands(context, output);

	if (!vscode.workspace.isTrusted) {
		reportUnavailable(output, statusOnly, 'untrusted');
		context.subscriptions.push(
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				void bootstrap(context, output);
			})
		);
		return buildApi();
	}

	await bootstrap(context, output);
	return buildApi();
}

export function deactivate(): void {
	session?.monitor.dispose();
	session = undefined;
}

async function bootstrap(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
	const settings = readSettings();
	const support = workspaceIsSupported();

	if (!settings.enabled) {
		reportUnavailable(output, statusOnly!, 'disabled');
		registerEnableWatcher(context, output);
		return;
	}
	if (!support.supported) {
		reportUnavailable(output, statusOnly!, 'unsupported', support.reason);
		registerEnableWatcher(context, output);
		return;
	}
	if (!vscode.workspace.isTrusted) {
		reportUnavailable(output, statusOnly!, 'untrusted');
		return;
	}

	// Tear down any previous session (settings or folders changed).
	session?.monitor.dispose();

	const folders = vscode.workspace.workspaceFolders ?? [];
	const storeInWorkspace = settings.storageLocation === 'workspace' && folders.length > 0 && folders[0].uri.scheme === 'file';

	let workspaceId: string;
	let storageRoot: string;
	let identityBaseDir: string | undefined;
	if (storeInWorkspace) {
		// History travels with the project: the store lives inside the first
		// workspace folder and file identity is derived from paths relative to
		// that folder, so a zipped-and-shared tree keeps its timelines.
		identityBaseDir = folders[0].uri.fsPath;
		workspaceId = 'workspace-local';
		storageRoot = path.join(identityBaseDir, '.file-history');
	} else {
		workspaceId = computeWorkspaceId(
			folders.map(folder => ({
				uri: folder.uri.toString(),
				name: folder.name
			})),
			vscode.workspace.name ?? context.extensionPath
		);
		storageRoot = path.join(context.globalStorageUri.fsPath, 'workspaces', workspaceId);
	}

	let store: HistoryStore;
	try {
		await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
		if (storeInWorkspace) {
			// Keep version control away from the snapshots without asking the
			// user to edit their ignore files.
			try {
				await fs.writeFile(path.join(storageRoot, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
			}
		}
		store = await HistoryStore.open({
			rootDir: storageRoot,
			workspaceId,
			identityBaseDir,
			policy: settings.policy,
			log: message => log(output, message)
		});
	} catch (err) {
		const message = (err as Error).message;
		reportUnavailable(output, statusOnly!, 'error', `History storage could not be opened: ${message}`);
		void vscode.window.showErrorMessage(
			`Automatic File History could not open its storage folder (${message}). No snapshots will be captured.`
		);
		return;
	}

	log(output, `History storage: ${storageRoot}`);

	const status = statusOnly!;
	const monitor = new FileHistoryMonitor({
		store,
		storageRoot,
		getSettings: () => session?.settings ?? readSettings(),
		onStatus: next => status.update(next, statusVisibility(settings)),
		onHistoryChanged: absPath => {
			session?.historyView.refresh(absPath);
			session?.filesView.refresh();
		},
		log: message => log(output, message)
	});

	const historyView = new HistoryView(monitor);
	const filesView = new FilesView(monitor, () => session?.settings.recentFilesLimit ?? 50);
	const snapshots = new SnapshotContentProvider(store);

	context.subscriptions.push(
		historyView,
		filesView,
		snapshots,
		vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots),
		vscode.window.registerTreeDataProvider('automaticFileHistory.revisions', historyView),
		vscode.window.registerTreeDataProvider('automaticFileHistory.files', filesView)
	);

	session = { store, monitor, historyView, filesView, snapshots, status, output, settings };

	status.update(
		{ phase: 'initializing', message: 'Starting monitoring…' },
		statusVisibility(settings)
	);

	registerCommands(context);
	registerConfigurationWatchers(context, output);

	// Watchers are registered synchronously inside start(); the baseline scan then
	// runs in the background so activation stays fast.
	void monitor.start().catch(err => {
		log(output, `Monitoring failed to start: ${(err as Error).message}`);
		status.update(
			{ phase: 'error', message: `Monitoring failed to start: ${(err as Error).message}` },
			statusVisibility(settings)
		);
	});
}

function statusVisibility(settings: ExtensionSettings): {
	visible: boolean;
	enabled: boolean;
	supported: boolean;
} {
	return {
		visible: settings.showStatusBar,
		enabled: settings.enabled,
		supported: workspaceIsSupported().supported
	};
}

function reportUnavailable(
	output: vscode.OutputChannel,
	status: StatusIndicator,
	reason: 'disabled' | 'unsupported' | 'untrusted' | 'error',
	detail?: string
): void {
	const phase = reason === 'error' ? 'error' : reason === 'disabled' ? 'disabled' : 'unsupported';
	const message =
		detail ??
		(reason === 'disabled'
			? 'Turn on "automaticFileHistory.enabled" to start capturing.'
			: reason === 'untrusted'
				? 'This workspace is not trusted, so nothing is captured.'
				: workspaceIsSupported().reason);
	log(output, `Monitoring unavailable (${reason}): ${message}`);
	status.update({ phase, message }, { visible: true, enabled: false, supported: false });
	void vscode.commands.executeCommand('setContext', 'automaticFileHistory.monitoring', false);
	void vscode.commands.executeCommand('setContext', 'automaticFileHistory.enabledContext', false);
}

function registerEnableWatcher(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async event => {
			if (event.affectsConfiguration('automaticFileHistory.enabled')) {
				await bootstrap(context, output);
			}
		})
	);
}

function registerConfigurationWatchers(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async event => {
			if (!event.affectsConfiguration('automaticFileHistory')) {
				return;
			}
			if (event.affectsConfiguration('automaticFileHistory.storageLocation')) {
				const action = await vscode.window.showInformationMessage(
					'Reload the window to change Automatic File History storage. Existing history stays in its current location.',
					'Reload Window'
				);
				if (action === 'Reload Window') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
				return;
			}
			const next = readSettings();
			if (!next.enabled) {
				await bootstrap(context, output);
				return;
			}
			if (!session) {
				return;
			}
			next.storageLocation = session.settings.storageLocation;
			session.settings = next;
			session.store.setPolicy(next.policy);
			session.monitor.applyPolicy(next.policy);
			if (event.affectsConfiguration('automaticFileHistory.showStatusBar')) {
				session.status.update(currentStatus(session), statusVisibility(next));
			}
			session.historyView.refresh();
			session.filesView.refresh();
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void bootstrap(context, output);
		})
	);
}

function currentStatus(target: Session): MonitorStatus {
	return {
		phase: target.monitor.currentPhase,
		message: target.monitor.isScanning ? 'Building first snapshots…' : undefined
	};
}

// ---------------------------------------------------------------- commands

/** Commands that must exist even when monitoring cannot run. */
function registerViewlessCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('automaticFileHistory.showStorageUsage', () => showStorageUsage(output))
	);
}

function registerCommands(context: vscode.ExtensionContext): void {
	const register = (command: string, callback: (...args: never[]) => unknown): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(command, callback as (...args: unknown[]) => unknown)
		);
	};

	register('automaticFileHistory.refresh', () => {
		session?.historyView.refresh();
		session?.filesView.refresh();
	});

	register('automaticFileHistory.openRevision', async (item: RevisionItem) => {
		const target = resolveRevision(item);
		if (target) {
			await recovery.openRevision(target);
		}
	});

	register('automaticFileHistory.compareWithCurrent', async (item: RevisionItem) => {
		const target = resolveRevision(item);
		if (target) {
			await recovery.compareWithCurrent(target);
		}
	});

	register('automaticFileHistory.compareWithPrevious', async (item: RevisionItem) => {
		const target = resolveRevision(item);
		if (target) {
			await recovery.compareWithPrevious(target);
		}
	});

	register('automaticFileHistory.exportRevision', async (item: RevisionItem) => {
		const active = session;
		const target = resolveRevision(item);
		if (active && target) {
			await recovery.exportRevision({ store: active.store, monitor: active.monitor, log: m => log(active.output, m) }, target);
		}
	});

	register('automaticFileHistory.restore', async (item: RevisionItem) => {
		const active = session;
		const target = resolveRevision(item);
		if (active && target) {
			await recovery.restoreRevision(
				{ store: active.store, monitor: active.monitor, log: m => log(active.output, m) },
				target
			);
		}
	});

	register('automaticFileHistory.restoreDeletedFile', async (arg: FileItem | RevisionItem | vscode.Uri) => {
		const active = session;
		if (!active) {
			return;
		}
		const absPath = resolvePathArg(arg);
		await recovery.restoreDeletedFile(
			{ store: active.store, monitor: active.monitor, log: m => log(active.output, m) },
			undefined,
			absPath
		);
	});

	register('automaticFileHistory.captureNow', async (arg?: FileItem | vscode.Uri) => {
		const active = session;
		if (!active) {
			return;
		}
		const absPath = resolvePathArg(arg) ?? vscode.window.activeTextEditor?.document.uri.fsPath;
		if (!absPath) {
			void vscode.window.showInformationMessage('Open or select a file to capture a checkpoint.');
			return;
		}
		const outcome = await active.monitor.captureNow(absPath, 'checkpoint', 'Manual checkpoint.');
		switch (outcome.kind) {
			case 'captured':
				void vscode.window.showInformationMessage(
					`Checkpoint stored for ${path.basename(absPath)} (snapshot #${outcome.seq}).`
				);
				break;
			case 'unchanged':
				void vscode.window.showInformationMessage(
					`${path.basename(absPath)} is unchanged since the last snapshot, so nothing new was stored.`
				);
				break;
			case 'deleted':
				void vscode.window.showInformationMessage(
					`${path.basename(absPath)} is gone; the deletion was recorded and earlier snapshots remain.`
				);
				break;
			case 'skipped':
				void vscode.window.showWarningMessage(`Not captured: ${outcome.reason ?? 'file is not eligible'}`);
				break;
			case 'failed':
				void vscode.window.showErrorMessage(`Capture failed: ${outcome.error ?? outcome.reason ?? 'unknown error'}`);
				break;
		}
	});

	register('automaticFileHistory.deleteFileHistory', async (arg?: FileItem | RevisionItem | vscode.Uri) => {
		const active = session;
		if (!active) {
			return;
		}
		const absPath = resolvePathArg(arg);
		if (!absPath) {
			return;
		}
		const history = await active.store.getHistoryByPath(absPath);
		const count = history?.revisions.length ?? 0;
		const confirm = await vscode.window.showWarningMessage(
			`Delete all stored history for "${history?.relPath ?? path.basename(absPath)}"?`,
			{
				modal: true,
				detail:
					count === 0
						? 'No snapshots are stored for this file.'
						: `${count} snapshot(s) will be permanently deleted. This cannot be undone.`
			},
			count === 0 ? 'OK' : 'Delete History'
		);
		if (!confirm) {
			return;
		}
		const result = await active.store.deleteHistoryByPath(absPath);
		active.historyView.refresh();
		active.filesView.refresh();
		void vscode.window.showInformationMessage(
			`Deleted ${result.removedRevisions} snapshot(s) and freed ${formatSize(result.freedBytes)}.`
		);
	});

	register('automaticFileHistory.clearWorkspaceHistory', async () => {
		const active = session;
		if (!active) {
			return;
		}
		const usage = await active.store.usage();
		const confirm = await vscode.window.showWarningMessage(
			'Delete every snapshot stored for this workspace?',
			{
				modal: true,
				detail: [
					`${usage.fileCount} file(s), ${usage.revisionCount} snapshot(s), ${formatSize(usage.blobBytes)}.`,
					`Storage: ${usage.rootDir}`,
					'This cannot be undone and does not touch the files in your workspace.'
				].join('\n')
			},
			'Delete All History'
		);
		if (confirm !== 'Delete All History') {
			return;
		}
		await active.store.clearWorkspace();
		active.historyView.refresh();
		active.filesView.refresh();
		void vscode.window.showInformationMessage('Workspace history deleted.');
	});

	register('automaticFileHistory.pauseMonitoring', () => {
		session?.monitor.setPaused(true);
		void vscode.window.showInformationMessage(
			'Automatic File History is paused. Changes made now are not captured and cannot be recovered later.'
		);
	});

	register('automaticFileHistory.resumeMonitoring', () => {
		session?.monitor.setPaused(false);
		void session?.monitor.start();
	});

	register('automaticFileHistory.pinFile', async () => {
		const active = session;
		if (!active) {
			return;
		}
		const summaries = await active.store.listSummaries();
		const picked = await pickFile(summaries, 'Choose a file to follow');
		if (picked) {
			active.historyView.pinFile(picked.path);
			await revealHistoryView();
		}
	});

	register('automaticFileHistory.unpinFile', () => {
		session?.historyView.unpin();
	});

	register('automaticFileHistory.showFileHistory', async (arg?: FileItem | vscode.Uri) => {
		const active = session;
		if (!active) {
			return;
		}
		const absPath = resolvePathArg(arg);
		if (!absPath) {
			return;
		}
		active.historyView.pinFile(absPath);
		await revealHistoryView();
	});

	register('automaticFileHistory.showRecentlyChanged', async () => {
		const active = session;
		if (!active) {
			return;
		}
		const summaries = await active.store.listSummaries();
		const picked = await pickFile(summaries, 'Recently changed and deleted files', true);
		if (picked) {
			active.historyView.pinFile(picked.path);
			await revealHistoryView();
		}
	});

	void vscode.commands.executeCommand('setContext', 'automaticFileHistory.installed', true);
}

async function revealHistoryView(): Promise<void> {
	try {
		await vscode.commands.executeCommand('automaticFileHistory.revisions.focus');
	} catch {
		await vscode.commands.executeCommand('workbench.view.explorer');
	}
}

async function pickFile(
	summaries: FileSummary[],
	placeholder: string,
	includeDeletedFirst = false
): Promise<FileSummary | undefined> {
	if (summaries.length === 0) {
		void vscode.window.showInformationMessage(
			'Nothing has been captured for this workspace yet. History appears once a change is observed.'
		);
		return undefined;
	}
	const ordered = includeDeletedFirst
		? [...summaries].sort((a, b) => Number(b.deleted) - Number(a.deleted))
		: summaries;
	const items = ordered.slice(0, 200).map(summary => ({
		label: summary.deleted ? `$(trash) ${summary.relPath}` : `$(file) ${summary.relPath}`,
		description: `${summary.revisionCount} snapshot(s) · ${formatRelative(summary.lastObservedAt ?? '')}`,
		detail: summary.lastObservedAt ? formatTimestamp(summary.lastObservedAt) : summary.path,
		summary
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: placeholder,
		matchOnDescription: true,
		matchOnDetail: true
	});
	return picked?.summary;
}

function resolveRevision(item: RevisionItem | undefined): recovery.RevisionTarget | undefined {
	const active = session;
	if (!active || !(item instanceof RevisionItem)) {
		if (item) {
			void vscode.window.showInformationMessage('Choose a snapshot in the Automatic File History view first.');
		}
		return undefined;
	}
	const context = item.revisionContext;
	const history = active.historyView.history;
	if (!history || history.fileId !== context.fileId) {
		void vscode.window.showInformationMessage('That snapshot list is out of date. Refresh the view and try again.');
		return undefined;
	}
	const revision = findRevision(history, context.revision.seq);
	if (!revision) {
		void vscode.window.showInformationMessage('That snapshot is no longer stored.');
		return undefined;
	}
	return { history, revision };
}

/** Accept a tree item, an Explorer URI, or nothing (fall back to the editor). */
function resolvePathArg(arg: FileItem | RevisionItem | vscode.Uri | undefined): string | undefined {
	if (!arg) {
		return session?.historyView.currentFile?.absPath;
	}
	if (arg instanceof FileItem) {
		return arg.summary.path;
	}
	if (arg instanceof RevisionItem) {
		return arg.revisionContext.absPath;
	}
	if (arg instanceof vscode.Uri) {
		return arg.scheme === 'file' ? arg.fsPath : undefined;
	}
	const candidate = (arg as { summary?: FileSummary; revisionContext?: { absPath?: string } });
	if (candidate.summary?.path) {
		return candidate.summary.path;
	}
	if (candidate.revisionContext?.absPath) {
		return candidate.revisionContext.absPath;
	}
	return session?.historyView.currentFile?.absPath;
}

async function showStorageUsage(output: vscode.OutputChannel): Promise<void> {
	const active = session;
	if (!active) {
		void vscode.window.showInformationMessage(
			'Automatic File History is not monitoring this workspace. Open a trusted local folder and make sure the extension is enabled.'
		);
		return;
	}
	const usage = await active.store.usage();
	const status = currentStatus(active);
	const settings = active.settings;

	interface UsageItem extends vscode.QuickPickItem {
		action?: 'reveal' | 'gc' | 'budget' | 'output' | 'pause';
	}
	const unlimitedBudget = !(settings.policy.workspaceBudgetBytes > 0);
	const unlimitedRevisions = !(settings.policy.maxRevisionsPerFile > 0);
	const budgetLine = unlimitedBudget
		? `Snapshot storage: ${formatSize(usage.blobBytes)} · no budget, every snapshot is kept`
		: `Snapshot storage: ${formatSize(usage.blobBytes)} of ${formatSize(settings.policy.workspaceBudgetBytes)} budget`;
	const limitLine = unlimitedRevisions
		? `Per-file limit: keep every snapshot · max tracked size ${formatSize(settings.policy.maxFileBytes)}`
		: `Per-file limit: ${settings.policy.maxRevisionsPerFile} snapshots · max tracked size ${formatSize(settings.policy.maxFileBytes)}`;
	const items: UsageItem[] = [
		{
			label: `$(pulse) Status: ${status.phase}`,
			description: active.monitor.isScanning ? 'building first snapshots' : undefined,
			detail: [
				status.message,
				`Scanned ${usage.fileCount} tracked file(s) · ${usage.revisionCount} snapshot(s) stored`,
				budgetLine,
				usage.overBudgetBytes > 0 ? `Over budget by ${formatSize(usage.overBudgetBytes)}` : undefined,
				`Metadata: ${formatSize(usage.manifestBytes)} · ${usage.prunedRevisions > 0 ? `pruned ${usage.prunedRevisions} snapshot(s)` : 'nothing auto-pruned'}`,
				limitLine,
				`Storage folder: ${usage.rootDir}`
			]
				.filter(Boolean)
				.join('\n')
		},
		{ label: '$(folder-opened) Open Storage Folder', action: 'reveal' },
		{ label: '$(trash) Remove Orphaned Snapshots Now', description: 'garbage collection', action: 'gc' },
		{
			label: '$(gear) Apply Retention Budget Now',
			description: unlimitedBudget ? 'no budget set — nothing to prune' : 'prune oldest snapshots',
			action: 'budget'
		},
		{
			label: active.monitor.currentPhase === 'paused' ? '$(debug-continue) Resume Monitoring' : '$(debug-pause) Pause Monitoring',
			action: 'pause'
		},
		{ label: '$(output) Show Extension Log', action: 'output' }
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Automatic File History',
		placeHolder: 'Monitoring status, storage usage, and maintenance'
	});
	if (!picked?.action) {
		return;
	}

	switch (picked.action) {
		case 'reveal':
			void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(usage.rootDir));
			break;
		case 'gc': {
			const result = await active.store.gc({ graceMs: 0 });
			void vscode.window.showInformationMessage(
				`Removed ${result.removedBlobs} unreferenced snapshot file(s), freeing ${formatSize(result.freedBytes)}.`
			);
			log(output, `Manual GC removed ${result.removedBlobs} blob(s), ${result.freedBytes} bytes`);
			break;
		}
		case 'budget': {
			if (!(settings.policy.workspaceBudgetBytes > 0)) {
				void vscode.window.showInformationMessage(
					'No workspace budget is set, so every snapshot is kept and nothing was pruned. Set automaticFileHistory.workspaceBudgetMB to enable size-based pruning.'
				);
				break;
			}
			const result = await active.store.enforceBudget();
			await active.store.gc({ graceMs: 0 });
			void vscode.window.showInformationMessage(
				result.prunedRevisions === 0
					? 'Storage is already within the configured budget; nothing was pruned.'
					: `Pruned ${result.prunedRevisions} snapshot(s) across ${result.filesTouched} file(s), freeing about ${formatSize(result.freedBytes)}.`
			);
			break;
		}
		case 'pause':
			await vscode.commands.executeCommand(
				active.monitor.currentPhase === 'paused'
					? 'automaticFileHistory.resumeMonitoring'
					: 'automaticFileHistory.pauseMonitoring'
			);
			break;
		case 'output':
			active.output.show(true);
			break;
	}
}

function describeWorkspace(): string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		return 'no folder';
	}
	return folders.map(folder => folder.uri.fsPath).join(', ');
}

/**
 * Log progress and failures, never file content. Keeping source text out of the
 * log is a deliberate privacy boundary.
 */
function log(output: vscode.OutputChannel, message: string): void {
	output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * The extension's returned API.
 *
 * This is the cooperative surface described in the plan: a tool that wants a
 * checkpoint with an honest label can ask for one and await the acknowledgement.
 * It does not imply automatic integration with any agent, and awaiting
 * `captureNow` after a write still cannot cover unrelated concurrent writers.
 */
export interface AutomaticFileHistoryApi {
	readonly version: 1;
	/** True when monitoring is running for a trusted, supported workspace. */
	isActive(): boolean;
	/** Absolute path of this workspace's history storage, when active. */
	storageRoot(): string | undefined;
	status(): MonitorStatus | undefined;
	/** Wait for the startup baseline scan; false on timeout. */
	waitForStartupScan(timeoutMs?: number): Promise<boolean>;
	historyFor(absPath: string): Promise<FileHistory | null>;
	/** Capture the current state of one file and await the acknowledgement. */
	captureNow(absPath: string, note?: string): Promise<CaptureOutcome>;
	/** Explain why a file has no history, using the same wording as the views. */
	describeFile(absPath: string): Promise<FileDescription>;
}

function buildApi(): AutomaticFileHistoryApi {
	return {
		version: 1,
		isActive: () => session !== undefined && session.monitor.currentPhase !== 'disabled',
		storageRoot: () => session?.store.rootDir,
		status: () => (session ? currentStatus(session) : statusOnly?.status),
		waitForStartupScan: (timeoutMs = 60_000) =>
			session ? session.monitor.waitForStartupScan(timeoutMs) : Promise.resolve(false),
		historyFor: absPath =>
			session
				? session.store.getHistoryByPath(absPath)
				: Promise.resolve(null),
		captureNow: (absPath, note) =>
			session
				? session.monitor.captureNow(absPath, 'checkpoint', note ?? 'Checkpoint requested through the extension API.')
				: Promise.resolve({
						kind: 'skipped' as const,
						path: absPath,
						relPath: path.basename(absPath),
						reason: 'Automatic File History is not monitoring this workspace.',
						skipReason: 'excluded' as const
					}),
		describeFile: absPath =>
			session
				? session.monitor.describeFile(absPath)
				: Promise.resolve({
						history: null,
						state: 'none' as const,
						detail: 'Automatic File History is not monitoring this workspace.'
					})
	};
}
