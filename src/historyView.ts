import * as path from 'node:path';
import * as vscode from 'vscode';
import { EVENT_LABELS, EVENT_NOTES, type FileHistory, type Revision } from './core/types';
import type { FileHistoryMonitor } from './capture';
import { formatRelative, formatSize, formatTimestamp, shortHash } from './format';
import { snapshotUri } from './snapshotProvider';

export interface RevisionItemContext {
	absPath: string;
	relPath: string;
	fileId: string;
	revision: Revision;
	isLatest: boolean;
	/** The next older revision, when there is one. */
	previous?: Revision;
	index: number;
	total: number;
}

export class InfoItem extends vscode.TreeItem {
	override readonly contextValue = 'afh.info';
	constructor(label: string, detail?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = detail;
		this.tooltip = detail ? `${label}\n\n${detail}` : label;
		this.iconPath = new vscode.ThemeIcon('info');
	}
}

export class PinnedHeaderItem extends vscode.TreeItem {
	override readonly contextValue = 'afh.pinnedHeader';
	constructor(relPath: string) {
		super(`Pinned: ${relPath}`, vscode.TreeItemCollapsibleState.None);
		this.description = 'not following the editor';
		this.tooltip =
			'This view is pinned to one file.\n\nUse "Follow Active Editor Again" to switch back to following the active editor.';
		this.iconPath = new vscode.ThemeIcon('pinned');
	}
}

export class RevisionItem extends vscode.TreeItem {
	override readonly contextValue: string;
	readonly revisionContext: RevisionItemContext;

	constructor(context: RevisionItemContext) {
		super(buildLabel(context), vscode.TreeItemCollapsibleState.None);
		this.revisionContext = context;
		const { revision, isLatest } = context;

		if (revision.event === 'deleted') {
			this.contextValue = 'afh.deletion';
			this.description = `${formatRelative(revision.observedAt)} · deleted`;
			this.iconPath = new vscode.ThemeIcon('trash');
			this.tooltip = buildTooltip(context);
			return;
		}

		this.contextValue = isLatest ? 'afh.revision.latest' : 'afh.revision';
		this.description = `${formatRelative(revision.observedAt)} · ${formatSize(revision.size)}`;
		this.iconPath = new vscode.ThemeIcon(iconForEvent(revision.event));
		this.tooltip = buildTooltip(context);
		this.resourceUri = snapshotUri(context.fileId, revision.seq, path.basename(context.relPath));
		this.command = {
			command: 'automaticFileHistory.openRevision',
			title: 'Open Snapshot',
			arguments: [this]
		};
	}
}

function buildLabel(context: RevisionItemContext): string {
	const { revision, isLatest, index, total } = context;
	const label = EVENT_LABELS[revision.event] ?? revision.event;
	const position = `#${revision.seq}`;
	if (revision.event === 'deleted') {
		return `${label} ${position}`;
	}
	return isLatest ? `${label} ${position} · latest of ${total}` : `${label} ${position} · ${total - index} back`;
}

function buildTooltip(context: RevisionItemContext): string {
	const { revision, relPath, absPath, isLatest } = context;
	const lines = [
		`**${EVENT_LABELS[revision.event] ?? revision.event}** · snapshot #${revision.seq}${isLatest ? ' (latest)' : ''}`,
		'',
		`File: \`${relPath}\``,
		`Observed: ${formatTimestamp(revision.observedAt)} (${formatRelative(revision.observedAt)})`,
		revision.event === 'deleted'
			? 'No content: this entry records that the file was gone.'
			: `Size: ${formatSize(revision.size)} · sha256 ${shortHash(revision.hash)}…`,
		revision.origin === 'editor' ? 'Origin: saved from a VS Code editor in this window.' : 'Origin: not identified (reported as a disk change).'
	];
	const note = EVENT_NOTES[revision.event];
	if (note) {
		lines.push('', note);
	}
	if (revision.note) {
		lines.push('', revision.note);
	}
	lines.push('', `\`${absPath}\``);
	return lines.join('\n');
}

function iconForEvent(event: Revision['event']): string {
	switch (event) {
		case 'baseline':
			return 'milestone';
		case 'observed-on-startup':
			return 'eye';
		case 'editor-save':
			return 'save';
		case 'created':
			return 'add';
		case 'deleted':
			return 'trash';
		case 'restored':
			return 'history';
		case 'checkpoint':
			return 'bookmark';
		default:
			return 'pencil';
	}
}

/**
 * The Explorer view named "Automatic File History".
 *
 * Follows the active editor unless the user pinned a specific file. Newest
 * revision first, with an explanatory row whenever there is nothing to show.
 */
export class HistoryView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	private readonly disposables: vscode.Disposable[] = [];
	private followed: { absPath: string; relPath: string } | undefined;
	private pinned = false;
	private lastHistory: FileHistory | undefined;

	constructor(private readonly monitor: FileHistoryMonitor) {
		this.disposables.push(
			this.emitter,
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (this.pinned || !editor || editor.document.uri.scheme !== 'file') {
					return;
				}
				this.followEditor(editor.document.uri.fsPath);
			})
		);
		const active = vscode.window.activeTextEditor;
		if (active && active.document.uri.scheme === 'file') {
			this.followed = {
				absPath: active.document.uri.fsPath,
				relPath: displayName(active.document.uri.fsPath)
			};
		}
	}

	get currentFile(): { absPath: string; relPath: string } | undefined {
		return this.followed;
	}

	get history(): FileHistory | undefined {
		return this.lastHistory;
	}

	get isPinned(): boolean {
		return this.pinned;
	}

	private followEditor(absPath: string): void {
		if (this.followed?.absPath === absPath) {
			return;
		}
		this.followed = { absPath, relPath: displayName(absPath) };
		this.refresh();
	}

	/** Pin the view to one file, used by Explorer/editor context actions. */
	pinFile(absPath: string): void {
		this.followed = { absPath, relPath: displayName(absPath) };
		this.pinned = true;
		this.refresh();
	}

	unpin(): void {
		this.pinned = false;
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			this.followed = {
				absPath: editor.document.uri.fsPath,
				relPath: displayName(editor.document.uri.fsPath)
			};
		}
		this.refresh();
	}

	/** Refresh in place, keeping the current follow/pin state. */
	refresh(absPath?: string): void {
		if (absPath && this.followed && this.followed.absPath !== absPath) {
			return;
		}
		this.emitter.fire(undefined);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		if (!this.followed) {
			return [
				new InfoItem(
					'No file selected',
					'Open a file, or right-click one in the Explorer and choose "Show Automatic File History". The view follows the active editor unless you pin a file.'
				)
			];
		}

		const description = await this.monitor.describeFile(this.followed.absPath);
		this.lastHistory = description.history ?? undefined;

		if (!description.history || description.history.revisions.length === 0) {
			const items: vscode.TreeItem[] = [];
			if (this.pinned) {
				items.push(new PinnedHeaderItem(this.followed.relPath));
			}
			items.push(new InfoItem(headlineFor(description.state), description.detail));
			return items;
		}

		const history = description.history;
		const revisions = [...history.revisions].reverse();
		const items: vscode.TreeItem[] = [];
		if (this.pinned) {
			items.push(new PinnedHeaderItem(this.followed.relPath));
		}
		if (history.pruned && history.pruned > 0) {
			items.push(
				new InfoItem(
					`${history.pruned} older snapshot(s) pruned`,
					'Retention kept the first captured state and the newest states. Pruned content is unrecoverable.'
				)
			);
		}

		revisions.forEach((revision, index) => {
			const ordered = history.revisions;
			const originalIndex = ordered.findIndex(candidate => candidate.seq === revision.seq);
			items.push(
				new RevisionItem({
					absPath: history.path,
					relPath: history.relPath,
					fileId: history.fileId,
					revision,
					isLatest: index === 0 && revision.event !== 'deleted',
					previous: originalIndex > 0 ? ordered[originalIndex - 1] : undefined,
					index,
					total: ordered.length
				})
			);
		});

		return items;
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}
}

function headlineFor(state: string): string {
	switch (state) {
		case 'initializing':
			return 'Still initializing';
		case 'skipped':
			return 'Not tracked';
		case 'failed':
			return 'Capture failed';
		case 'missing':
			return 'File not found';
		default:
			return 'No previous state captured';
	}
}

/** Workspace-relative display name when available, otherwise the basename. */
function displayName(absPath: string): string {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
	if (!folder) {
		return path.basename(absPath);
	}
	const rel = path.relative(folder.uri.fsPath, absPath).split(path.sep).join('/');
	return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1
		? `${folder.name}/${rel}`
		: rel;
}
