import * as vscode from 'vscode';
import { DEFAULT_POLICY, type CapturePolicy } from './core/types';

export interface ExtensionSettings {
	enabled: boolean;
	/** Where the store lives: inside the first workspace folder, or in global storage. */
	storageLocation: 'workspace' | 'extension';
	followActiveEditor: boolean;
	captureOnSave: boolean;
	showStatusBar: boolean;
	recentFilesLimit: number;
	policy: CapturePolicy;
}

const MB = 1024 * 1024;

function clamp(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

/**
 * Read a limit where `0` means "unlimited" (keep everything). Any non-positive
 * or non-finite value collapses to `0`; positive values are clamped into range.
 */
function clampLimit(value: number, max: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.min(max, Math.max(1, Math.floor(value)));
}

/** Read every setting into a plain object the core modules can consume. */
export function readSettings(): ExtensionSettings {
	const config = vscode.workspace.getConfiguration('automaticFileHistory');

	const maxFileSizeMB = clamp(config.get<number>('maxFileSizeMB', 2), 0.1, 64, 2);
	// 0 = keep every snapshot (default). A positive value caps revisions per file.
	const maxRevisionsPerFile = clampLimit(config.get<number>('maxRevisionsPerFile', 0), 100_000);
	// 0 = no workspace budget (default). A positive value enables size-based pruning.
	const workspaceBudgetMB = clampLimit(config.get<number>('workspaceBudgetMB', 0), 102_400);
	const stabilizationDelayMs = clamp(
		Math.floor(config.get<number>('stabilizationDelayMs', 120)),
		0,
		5000,
		120
	);

	const policy: CapturePolicy = {
		...DEFAULT_POLICY,
		maxFileBytes: Math.round(maxFileSizeMB * MB),
		maxRevisionsPerFile,
		workspaceBudgetBytes: Math.round(workspaceBudgetMB * MB),
		excludeGlobs: sanitizeGlobs(config.get<string[]>('exclude', [])),
		includeGlobs: sanitizeGlobs(config.get<string[]>('include', [])),
		stabilizationDelayMs
	};

	return {
		enabled: config.get<boolean>('enabled', true),
		storageLocation: config.get<string>('storageLocation', 'workspace') === 'extension' ? 'extension' : 'workspace',
		followActiveEditor: config.get<boolean>('followActiveEditor', true),
		captureOnSave: config.get<boolean>('captureOnSave', true),
		showStatusBar: config.get<boolean>('showStatusBar', true),
		recentFilesLimit: clamp(
			Math.floor(config.get<number>('recentFilesLimit', 50)),
			5,
			500,
			50
		),
		policy
	};
}

function sanitizeGlobs(values: string[] | undefined): string[] {
	if (!Array.isArray(values)) {
		return [];
	}
	return values
		.filter((value): value is string => typeof value === 'string')
		.map(value => value.trim())
		.filter(value => value.length > 0);
}

/** True when every current workspace folder can be watched from this host. */
export function workspaceIsSupported(): { supported: boolean; reason?: string } {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return { supported: false, reason: 'Open a folder to start capturing history.' };
	}
	const unsupported = folders.find(folder => folder.uri.scheme !== 'file');
	if (unsupported) {
		return {
			supported: false,
			reason: `Remote and virtual folders are not supported ("${unsupported.name}").`
		};
	}
	return { supported: true };
}
