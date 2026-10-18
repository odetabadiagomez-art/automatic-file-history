import * as vscode from 'vscode';
import type { FileSummary } from './core/types';
import type { FileHistoryMonitor } from './capture';
import { EVENT_LABELS } from './core/types';
import { formatRelative, formatSize, formatTimestamp } from './format';

export class FileItem extends vscode.TreeItem {
	override readonly contextValue: string;
	readonly summary: FileSummary;

	constructor(summary: FileSummary) {
		super(summary.relPath || summary.path, vscode.TreeItemCollapsibleState.None);
		this.summary = summary;
		this.contextValue = summary.deleted ? 'afh.file.deleted' : 'afh.file';
		this.description = summary.deleted
			? `${formatRelative(summary.lastObservedAt ?? '')} · deleted`
			: `${formatRelative(summary.lastObservedAt ?? '')} · ${summary.revisionCount} snapshot(s)`;
		this.iconPath = new vscode.ThemeIcon(summary.deleted ? 'trash' : 'file');
		this.tooltip = [
			summary.deleted ? '**Deleted** - snapshots are still recoverable.' : `**${EVENT_LABELS[summary.latestEvent ?? 'disk-change']}**`,
			'',
			`File: \`${summary.path}\``,
			`Snapshots: ${summary.revisionCount}${summary.pruned ? ` (${summary.pruned} pruned)` : ''}`,
			summary.lastObservedAt
				? `Last observed: ${formatTimestamp(summary.lastObservedAt)} (${formatRelative(summary.lastObservedAt)})`
				: '',
			`Stored size: ${formatSize(summary.bytes)}`
		]
			.filter(line => line !== '')
			.join('\n');
		this.command = {
			command: 'automaticFileHistory.showFileHistory',
			title: 'Show History',
			arguments: [this]
		};
	}
}

/**
 * Workspace-level list of recently changed and deleted files, so a file that no
 * longer exists on disk stays discoverable and restorable.
 */
export class FilesView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(
		private readonly monitor: FileHistoryMonitor,
		private readonly getLimit: () => number
	) {}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		const summaries = await this.monitor.recentlyChanged(this.getLimit());
		if (summaries.length === 0) {
			const item = new vscode.TreeItem('No captured changes yet', vscode.TreeItemCollapsibleState.None);
			item.description = 'changes appear here once monitoring captures them';
			item.iconPath = new vscode.ThemeIcon('info');
			item.tooltip =
				'Nothing has been captured for this workspace yet.\n\n' +
				'History is stored only while VS Code is running and monitoring is active.';
			return [item];
		}
		return summaries.map(summary => new FileItem(summary));
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
