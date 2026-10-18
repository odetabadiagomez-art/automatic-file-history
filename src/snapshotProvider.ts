import * as vscode from 'vscode';
import type { HistoryStore } from './core/store';
import type { FileHistory, Revision } from './core/types';

export const SNAPSHOT_SCHEME = 'afh';

export interface SnapshotRef {
	fileId: string;
	seq: number;
}

/**
 * URI for a stored snapshot.
 *
 * `authority` carries the file identity and the first path segment carries the
 * revision sequence, so a snapshot can be resolved again after a restart with
 * no in-memory registry. The original basename is kept as the last segment so
 * VS Code infers the right language for diff highlighting.
 */
export function snapshotUri(fileId: string, seq: number, originalName: string): vscode.Uri {
	const safeName = originalName.replace(/[\\/]/g, '_') || 'snapshot';
	return vscode.Uri.from({
		scheme: SNAPSHOT_SCHEME,
		authority: fileId,
		path: `/${seq}/${safeName}`
	});
}

export function parseSnapshotUri(uri: vscode.Uri): SnapshotRef | undefined {
	if (uri.scheme !== SNAPSHOT_SCHEME || !uri.authority) {
		return undefined;
	}
	const segments = uri.path.split('/').filter(Boolean);
	const seq = Number.parseInt(segments[0] ?? '', 10);
	if (!Number.isFinite(seq)) {
		return undefined;
	}
	return { fileId: uri.authority, seq };
}

export function isSnapshotUri(uri: vscode.Uri): boolean {
	return uri.scheme === SNAPSHOT_SCHEME;
}

/** Read-only document provider backed by the same store the views use. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly store: HistoryStore) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const ref = parseSnapshotUri(uri);
		if (!ref) {
			throw new Error('Not a valid Automatic File History snapshot.');
		}
		const history = await this.store.getFileHistory(ref.fileId);
		if (!history) {
			throw new Error('This history record no longer exists. It may have been deleted or pruned.');
		}
		const revision = findRevision(history, ref.seq);
		if (!revision) {
			throw new Error(`Snapshot #${ref.seq} is no longer stored for this file.`);
		}
		if (!revision.hash) {
			throw new Error('This entry records a deletion; it has no content to open.');
		}
		// readBlob verifies the digest, so a damaged snapshot is reported
		// instead of being shown as if it were intact.
		const content = await this.store.readBlob(revision.hash);
		return content.toString('utf8');
	}

	/** Force a re-read the next time this snapshot is opened. */
	invalidate(uri: vscode.Uri): void {
		this.onDidChangeEmitter.fire(uri);
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}

export function findRevision(history: FileHistory, seq: number): Revision | undefined {
	return history.revisions.find(revision => revision.seq === seq);
}
