/**
 * Shared data model for the local history store.
 *
 * Everything in `src/core` is intentionally free of `vscode` imports so the
 * capture and persistence logic can be unit tested in plain Node.
 */

export const STORAGE_VERSION = 1;

/** How a captured state came to be observed. Labels are only as honest as the
 * trigger that produced them - we never claim to know which process wrote. */
export type RevisionEvent =
	| 'baseline'
	| 'observed-on-startup'
	| 'disk-change'
	| 'editor-save'
	| 'created'
	| 'deleted'
	| 'restored'
	| 'checkpoint';

/** Origin is only set when we actually know it (an editor save happened in this
 * window). Everything else stays `unknown` and is reported as a disk change. */
export type Origin = 'unknown' | 'editor' | 'external';

export interface Revision {
	/** Monotonic per-file sequence, used to order identical timestamps. */
	seq: number;
	/** sha256 hex of the captured bytes. Empty string for delete markers. */
	hash: string;
	/** Byte length of the captured content. 0 for delete markers. */
	size: number;
	/** Source file mtime at capture time, when known. Used only as a cheap
	 * startup pre-filter; identity is always decided by the content hash. */
	mtimeMs?: number;
	/** ISO-8601 observation time. */
	observedAt: string;
	event: RevisionEvent;
	origin: Origin;
	/** Blob path relative to the workspace storage root, e.g. `ab/abcd...`.
	 * Omitted for delete markers, which reference no content. */
	blob?: string;
	/** Free-form explanation surfaced in the UI (failure reason, restore source). */
	note?: string;
}

export interface FileHistory {
	version: number;
	fileId: string;
	workspaceId: string;
	/** Last known absolute path on disk. */
	path: string;
	/** Last known path relative to its workspace folder. */
	relPath: string;
	rootName?: string;
	createdAt: string;
	updatedAt: string;
	/** Next sequence number to hand out. Never decreases, even after pruning. */
	nextSeq: number;
	revisions: Revision[];
	/** Absolute paths this file was renamed from (VS Code-initiated renames). */
	renamedFrom?: string[];
	/** Number of revisions removed by retention. */
	pruned?: number;
	/** True while the file is absent from disk. Snapshots are kept. */
	deleted?: boolean;
}

/** Compact per-file row used by list views; derived from {@link FileHistory}. */
export interface FileSummary {
	fileId: string;
	path: string;
	relPath: string;
	rootName?: string;
	revisionCount: number;
	latestSeq?: number;
	latestHash?: string;
	latestEvent?: RevisionEvent;
	lastObservedAt?: string;
	bytes: number;
	deleted: boolean;
	pruned?: number;
}

export interface StorageUsage {
	rootDir: string;
	fileCount: number;
	revisionCount: number;
	prunedRevisions: number;
	blobCount: number;
	blobBytes: number;
	manifestBytes: number;
	overBudgetBytes: number;
}

export interface CapturePolicy {
	/** Files larger than this are never read into memory. */
	maxFileBytes: number;
	/** Revisions kept per file before the oldest are pruned. */
	maxRevisionsPerFile: number;
	/** Soft total blob budget for one workspace. */
	workspaceBudgetBytes: number;
	/** Globs that disqualify a file. Checked before includes. */
	excludeGlobs: string[];
	/** Globs that rescue a file from the default excludes. */
	includeGlobs: string[];
	/** Quiet period required before a read is considered stable. */
	stabilizationDelayMs: number;
	/** Bounded number of stability re-checks before giving up. */
	stabilizationAttempts: number;
	/** Bounded number of read retries after a failure. */
	readRetries: number;
	/** Concurrent files processed during the startup scan. */
	scanConcurrency: number;
}

export const DEFAULT_POLICY: CapturePolicy = {
	maxFileBytes: 2 * 1024 * 1024,
	maxRevisionsPerFile: 500,
	workspaceBudgetBytes: 1024 * 1024 * 1024,
	excludeGlobs: [],
	includeGlobs: [],
	stabilizationDelayMs: 120,
	stabilizationAttempts: 5,
	readRetries: 2,
	scanConcurrency: 8
};

export type AppendKind = 'captured' | 'unchanged' | 'deleted';

export interface AppendResult {
	kind: AppendKind;
	fileId: string;
	seq?: number;
	hash?: string;
	size?: number;
	event?: RevisionEvent;
	pruned?: number;
}

export interface CaptureRequest {
	/** Absolute path of the file on disk. */
	path: string;
	/** Path relative to the workspace folder, used for display and exclusions. */
	relPath: string;
	/** Name of the workspace folder that contains the file. */
	rootName?: string;
	event: RevisionEvent;
	origin: Origin;
	note?: string;
	/**
	 * Startup reconciliation: label the state as a first baseline, or as
	 * "observed on startup" when it diverges from the last persisted state.
	 */
	reconcile?: boolean;
}

export type CaptureOutcomeKind =
	| 'captured'
	| 'unchanged'
	| 'skipped'
	| 'deleted'
	| 'failed';

export interface CaptureOutcome {
	kind: CaptureOutcomeKind;
	path: string;
	relPath: string;
	seq?: number;
	hash?: string;
	size?: number;
	event?: RevisionEvent;
	/** Why nothing was captured: exclusion reason or failure message. */
	reason?: string;
	skipReason?: SkipReason;
	error?: string;
}

export type SkipReason =
	| 'too-large'
	| 'binary'
	| 'excluded'
	| 'symlink'
	| 'not-a-file'
	| 'extension-storage'
	| 'missing';

export interface Eligibility {
	eligible: boolean;
	reason?: SkipReason;
	/** Human-readable explanation, safe to show to the user. */
	detail?: string;
	/** The exclude pattern that matched, when the reason is `excluded`. */
	pattern?: string;
}

/** Human-facing labels. Kept next to the model so the UI and tests agree. */
export const EVENT_LABELS: Record<RevisionEvent, string> = {
	baseline: 'Baseline',
	'observed-on-startup': 'Observed on startup',
	'disk-change': 'Disk change',
	'editor-save': 'Editor save',
	created: 'Created',
	deleted: 'Deleted',
	restored: 'Restored',
	checkpoint: 'Checkpoint'
};

/** One-line honesty notes attached to labels that are easy to over-read. */
export const EVENT_NOTES: Partial<Record<RevisionEvent, string>> = {
	'observed-on-startup':
		'This state was first seen when monitoring started. Changes made while VS Code was closed are not recoverable.',
	baseline:
		'First state captured for this file. Earlier content was never observed and cannot be recovered.',
	'disk-change':
		'The file changed on disk. The writing process is not identified, so no tool or agent is named.'
};
