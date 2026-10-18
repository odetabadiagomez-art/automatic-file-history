import * as vscode from 'vscode';

export type MonitorPhase =
	| 'disabled'
	| 'unsupported'
	| 'initializing'
	| 'monitoring'
	| 'paused'
	| 'error';

export interface MonitorStatus {
	phase: MonitorPhase;
	/** Short line shown first in the tooltip. */
	message?: string;
	/** Longer explanation, including known coverage gaps. */
	detail?: string;
	scannedFiles?: number;
	capturedStates?: number;
	skippedFiles?: number;
	failures?: number;
}

const PHASE_TEXT: Record<MonitorPhase, string> = {
	disabled: '$(circle-slash) History Off',
	unsupported: '$(warning) History Unavailable',
	initializing: '$(sync~spin) History Initializing',
	monitoring: '$(history) History On',
	paused: '$(debug-pause) History Paused',
	error: '$(error) History Error'
};

const PHASE_TITLE: Record<MonitorPhase, string> = {
	disabled: 'Automatic File History is disabled in settings.',
	unsupported: 'This workspace cannot be monitored.',
	initializing: 'Building the first snapshots. The workspace is not fully protected yet.',
	monitoring: 'Monitoring this workspace.',
	paused: 'Monitoring is paused. Changes made now are not captured.',
	error: 'Monitoring hit an error. Some changes may not have been captured.'
};

const COVERAGE_NOTE =
	'Captures each distinct state observed while VS Code is running. Writes that happen between observations, ' +
	'and changes made while VS Code is closed, are not recoverable.';

/** Status-bar indicator plus the context keys the contributed menus rely on. */
export class StatusIndicator implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private lastStatus: MonitorStatus = { phase: 'disabled' };

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			'automaticFileHistory.status',
			vscode.StatusBarAlignment.Right,
			100
		);
		this.item.name = 'Automatic File History';
		this.item.command = 'automaticFileHistory.showStorageUsage';
	}

	get status(): MonitorStatus {
		return this.lastStatus;
	}

	update(status: MonitorStatus, options: { visible: boolean; enabled: boolean; supported: boolean }): void {
		this.lastStatus = status;
		this.item.text = PHASE_TEXT[status.phase];
		this.item.backgroundColor =
			status.phase === 'error'
				? new vscode.ThemeColor('statusBarItem.errorBackground')
				: status.phase === 'paused' || status.phase === 'unsupported'
					? new vscode.ThemeColor('statusBarItem.warningBackground')
					: undefined;

		const lines = [PHASE_TITLE[status.phase]];
		if (status.message) {
			lines.push(status.message);
		}
		if (status.detail) {
			lines.push(status.detail);
		}
		const counts: string[] = [];
		if (status.scannedFiles !== undefined) {
			counts.push(`scanned ${status.scannedFiles}`);
		}
		if (status.capturedStates !== undefined) {
			counts.push(`captured ${status.capturedStates}`);
		}
		if (status.skippedFiles !== undefined) {
			counts.push(`skipped ${status.skippedFiles}`);
		}
		if (status.failures !== undefined && status.failures > 0) {
			counts.push(`failed ${status.failures}`);
		}
		if (counts.length > 0) {
			lines.push(counts.join(' · '));
		}
		lines.push('', COVERAGE_NOTE);
		this.item.tooltip = new vscode.MarkdownString(lines.map(line => (line ? line : '&nbsp;')).join('\n\n'));

		if (options.visible && status.phase !== 'disabled') {
			this.item.show();
		} else {
			this.item.hide();
		}
		void vscode.commands.executeCommand(
			'setContext',
			'automaticFileHistory.monitoring',
			status.phase === 'monitoring' || status.phase === 'initializing'
		);
		void vscode.commands.executeCommand(
			'setContext',
			'automaticFileHistory.enabledContext',
			options.enabled && options.supported
		);
	}

	show(): void {
		this.item.show();
	}

	hide(): void {
		this.item.hide();
	}

	dispose(): void {
		this.item.dispose();
	}
}
