import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileHistoryMonitor } from './capture';
import { sha256Hex } from './core/ids';
import type { HistoryStore } from './core/store';
import type { FileHistory, Revision } from './core/types';
import { formatSize, formatTimestamp } from './format';
import { snapshotUri } from './snapshotProvider';

export interface RecoveryDeps {
	store: HistoryStore;
	monitor: FileHistoryMonitor;
	log: (message: string) => void;
}

export interface RevisionTarget {
	history: FileHistory;
	revision: Revision;
}

async function openSnapshotDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
	return vscode.workspace.openTextDocument(uri);
}

/** Open a stored snapshot read-only. */
export async function openRevision(target: RevisionTarget): Promise<void> {
	const uri = snapshotUri(target.history.fileId, target.revision.seq, path.basename(target.history.relPath));
	const document = await openSnapshotDocument(uri);
	await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

/** Diff a stored snapshot against the file as it exists on disk now. */
export async function compareWithCurrent(target: RevisionTarget): Promise<void> {
	const current = vscode.Uri.file(target.history.path);
	const exists = await fs
		.stat(target.history.path)
		.then(stat => stat.isFile())
		.catch(() => false);
	if (!exists) {
		const action = await vscode.window.showInformationMessage(
			`"${target.history.relPath}" no longer exists on disk, so there is nothing to compare against.`,
			'Open Snapshot'
		);
		if (action === 'Open Snapshot') {
			await openRevision(target);
		}
		return;
	}
	const left = snapshotUri(target.history.fileId, target.revision.seq, path.basename(target.history.relPath));
	await vscode.commands.executeCommand(
		'vscode.diff',
		left,
		current,
		`${path.basename(target.history.relPath)} (snapshot #${target.revision.seq} ↔ on disk)`
	);
}

/** Diff a stored snapshot against the snapshot captured just before it. */
export async function compareWithPrevious(target: RevisionTarget): Promise<void> {
	const previous = previousContentRevision(target.history, target.revision);
	if (!previous) {
		void vscode.window.showInformationMessage(
			'There is no earlier snapshot for this file, so there is nothing to compare against.'
		);
		return;
	}
	const name = path.basename(target.history.relPath);
	await vscode.commands.executeCommand(
		'vscode.diff',
		snapshotUri(target.history.fileId, previous.seq, name),
		snapshotUri(target.history.fileId, target.revision.seq, name),
		`${name} (#${previous.seq} ↔ #${target.revision.seq})`
	);
}

/** Copy a stored snapshot to a location the user chooses. */
export async function exportRevision(deps: RecoveryDeps, target: RevisionTarget): Promise<boolean> {
	if (!target.revision.hash) {
		void vscode.window.showWarningMessage('This entry records a deletion; it has no content to export.');
		return false;
	}
	let content: Buffer;
	try {
		// readBlob verifies the digest before the bytes leave the store.
		content = await deps.store.readBlob(target.revision.hash);
	} catch (err) {
		void vscode.window.showErrorMessage(`Could not read the snapshot: ${(err as Error).message}`);
		return false;
	}

	const base = path.basename(target.history.relPath);
	const ext = path.extname(base);
	const stem = ext ? base.slice(0, -ext.length) : base;
	const suggested = `${stem}.snapshot-${target.revision.seq}${ext}`;
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const defaultUri = folder ? vscode.Uri.joinPath(folder, suggested) : vscode.Uri.file(suggested);

	const destination = await vscode.window.showSaveDialog({
		defaultUri,
		title: 'Export snapshot',
		saveLabel: 'Export'
	});
	if (!destination) {
		return false;
	}
	try {
		await vscode.workspace.fs.writeFile(destination, content);
	} catch (err) {
		void vscode.window.showErrorMessage(`Could not export the snapshot: ${(err as Error).message}`);
		return false;
	}
	const reveal = await vscode.window.showInformationMessage(
		`Snapshot #${target.revision.seq} exported (${formatSize(content.length)}).`,
		'Reveal in Finder'
	);
	if (reveal === 'Reveal in Finder') {
		void vscode.commands.executeCommand('revealFileInOS', destination);
	}
	return true;
}

/**
 * Replace the current file with a stored snapshot.
 *
 * Order matters and follows the documented safety sequence: verify the blob,
 * resolve dirty editors, capture the state about to be replaced, re-check that
 * nothing changed in between, confirm, write, then capture the restored state.
 * Returns true only when the write actually happened.
 */
export async function restoreRevision(deps: RecoveryDeps, target: RevisionTarget): Promise<boolean> {
	const { store, monitor } = deps;
	const { history, revision } = target;

	if (!revision.hash) {
		void vscode.window.showWarningMessage(
			'This entry records a deletion and has no content. Choose a snapshot with content to restore.'
		);
		return false;
	}

	// 1. Verify integrity before anything else touches the file.
	let content: Buffer;
	try {
		content = await store.readBlob(revision.hash);
	} catch (err) {
		void vscode.window.showErrorMessage(
			`This snapshot failed its integrity check and was not restored: ${(err as Error).message}`
		);
		return false;
	}

	const targetUri = vscode.Uri.file(history.path);
	const fileExists = await fs
		.stat(history.path)
		.then(stat => stat.isFile())
		.catch(() => false);

	// 2. Never discard unsaved work silently.
	const openDocument = vscode.workspace.textDocuments.find(
		document => document.uri.scheme === 'file' && document.uri.fsPath === history.path
	);
	if (openDocument?.isDirty) {
		const choice = await vscode.window.showWarningMessage(
			`"${history.relPath}" has unsaved changes in an editor. Restore would replace that buffer.`,
			{ modal: true, detail: 'Save the editor first, or cancel and decide later.' },
			'Save and Continue'
		);
		if (choice !== 'Save and Continue') {
			return false;
		}
		await openDocument.save();
	}

	// 3. Capture the state that is about to be replaced.
	const preRestore = await monitor.captureNow(
		history.path,
		'disk-change',
		`Captured before restoring snapshot #${revision.seq}.`
	);
	const preRestoreHash = preRestore.hash ?? (fileExists ? await hashFromDisk(history.path) : undefined);

	// 4. Re-check for a concurrent external write.
	if (fileExists) {
		const hashNow = await hashFromDisk(history.path);
		if (preRestoreHash && hashNow && hashNow !== preRestoreHash) {
			void vscode.window.showErrorMessage(
				'Restore aborted: the file changed again while the restore was being prepared. Try again to capture the newer state first.'
			);
			return false;
		}
	}

	// 5. Confirm the destructive step, naming the exact path.
	const confirmLabel = fileExists ? 'Restore' : 'Recreate File';
	const confirmation = await vscode.window.showWarningMessage(
		fileExists
			? `Replace the current content of "${history.relPath}" with snapshot #${revision.seq}?`
			: `Recreate "${history.relPath}" from snapshot #${revision.seq}?`,
		{
			modal: true,
			detail: [
				`Snapshot: #${revision.seq}, ${formatTimestamp(revision.observedAt)}, ${formatSize(revision.size)}`,
				`Path: ${history.path}`,
				fileExists
					? 'The current content is stored as a new snapshot first, so this can be undone from history.'
					: 'The file does not exist on disk right now; it will be created at the path above.'
			].join('\n')
		},
		confirmLabel
	);
	if (confirmation !== confirmLabel) {
		return false;
	}

	// 6. Label the next captured state as a restore, then write.
	monitor.engine.setNextCaptureLabel(history.path, {
		event: 'restored',
		origin: openDocument ? 'editor' : 'unknown',
		note: `Restored from snapshot #${revision.seq}.`
	});

	try {
		if (openDocument && !openDocument.isDirty) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				targetUri,
				new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)),
				content.toString('utf8')
			);
			const applied = await vscode.workspace.applyEdit(edit);
			if (!applied) {
				monitor.engine.clearNextCaptureLabel(history.path);
				throw new Error('VS Code refused to update the open editor.');
			}
			await openDocument.save();
		} else {
			await vscode.workspace.fs.writeFile(targetUri, content);
		}
	} catch (err) {
		monitor.engine.clearNextCaptureLabel(history.path);
		void vscode.window.showErrorMessage(`Restore failed and the file was not changed: ${(err as Error).message}`);
		return false;
	}

	// 7. Make sure the restored state is stored, even if no save event fired.
	const after = await monitor.captureNow(
		history.path,
		'restored',
		`Restored from snapshot #${revision.seq}.`
	);
	if (after.kind === 'failed') {
		void vscode.window.showWarningMessage(
			`The file was restored, but the restored state could not be stored: ${after.error ?? after.reason ?? 'unknown error'}`
		);
		return true;
	}
	void vscode.window.showInformationMessage(
		`Restored "${history.relPath}" from snapshot #${revision.seq}. The previous content was kept in history.`
	);
	return true;
}

/**
 * Recreate a deleted file from its newest snapshot that has content. The path
 * shown in the confirmation is the path it will be written to.
 */
export async function restoreDeletedFile(
	deps: RecoveryDeps,
	history: FileHistory | undefined,
	absPath?: string
): Promise<boolean> {
	const resolved = history ?? (absPath ? await deps.store.getHistoryByPath(absPath) : undefined);
	if (!resolved) {
		void vscode.window.showInformationMessage('No history is stored for this file.');
		return false;
	}
	const latest = [...resolved.revisions].reverse().find(candidate => candidate.hash);
	if (!latest) {
		void vscode.window.showInformationMessage(
			`No snapshot with content is stored for "${resolved.relPath}", so there is nothing to recreate.`
		);
		return false;
	}
	return restoreRevision(deps, { history: resolved, revision: latest });
}

/** Newest revision before `revision` that actually has content. */
export function previousContentRevision(history: FileHistory, revision: Revision): Revision | undefined {
	const index = history.revisions.findIndex(candidate => candidate.seq === revision.seq);
	if (index <= 0) {
		return undefined;
	}
	for (let i = index - 1; i >= 0; i--) {
		if (history.revisions[i].hash) {
			return history.revisions[i];
		}
	}
	return undefined;
}

async function hashFromDisk(absPath: string): Promise<string | undefined> {
	try {
		return sha256Hex(await fs.readFile(absPath));
	} catch {
		return undefined;
	}
}
