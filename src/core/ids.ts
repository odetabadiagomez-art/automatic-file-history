import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** sha256 hex digest of the given bytes. */
export function sha256Hex(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Short, filesystem-safe digest used for identifiers. */
export function shortHash(value: string, length = 32): string {
	return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * Canonical form of a path used for identity comparisons.
 * Windows paths are case-insensitive, so identity is computed on a lowercased
 * form there; other platforms keep the exact bytes.
 */
export function canonicalPathForIdentity(absPath: string): string {
	const resolved = path.resolve(absPath);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Path with `/` separators, used for glob matching and display. */
export function toPosixPath(p: string): string {
	return p.split(path.sep).join('/');
}

/**
 * Stable identifier for a workspace. Derived from the sorted set of folder URIs
 * so every window on the same workspace agrees, and so history survives
 * restarts. Untitled multi-root workspaces fall back to the provided key.
 */
export function computeWorkspaceId(
	folders: Array<{ uri: string; name?: string }>,
	fallbackKey = 'no-folder'
): string {
	if (!folders || folders.length === 0) {
		return shortHash(`workspace:${fallbackKey}`);
	}
	const parts = folders
		.map(f => `${f.uri}\u0000${f.name ?? ''}`)
		.sort();
	return shortHash(`workspace:\u0001${parts.join('\u0002')}`);
}

/** Stable per-file identifier inside a workspace. */
export function computeFileId(workspaceId: string, absPath: string): string {
	return shortHash(`file:\u0001${workspaceId}\u0002${canonicalPathForIdentity(absPath)}`);
}

/**
 * Per-file identifier derived from the path relative to `baseDir` instead of
 * the absolute path. Used when history is stored inside the project: the whole
 * tree can be zipped, moved, or shared, and every file keeps the same identity
 * as long as its position relative to the store's folder does not change.
 */
export function computeRelativeFileId(workspaceId: string, baseDir: string, absPath: string): string {
	const base = canonicalPathForIdentity(baseDir);
	const relative = toPosixPath(path.relative(base, canonicalPathForIdentity(absPath)));
	return shortHash(`file:\u0001${workspaceId}\u0002${relative}`);
}

/** Blob layout: `blobs/<first two hex chars>/<full hash>`. */
export function blobRelativePath(hash: string): string {
	return `blobs/${hash.slice(0, 2)}/${hash}`;
}

/** Manifest layout: `files/<fileId>.json`. */
export function manifestRelativePath(fileId: string): string {
	return `files/${fileId}.json`;
}
