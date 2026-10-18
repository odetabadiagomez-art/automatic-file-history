import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isExcludedDirectory } from './eligibility';
import { canonicalPathForIdentity } from './ids';
import type { CapturePolicy } from './types';

export interface ScannedFile {
	absPath: string;
	relPath: string;
	size: number;
	mtimeMs: number;
}

export interface WalkOptions {
	/** Absolute workspace folder path. */
	rootDir: string;
	policy: CapturePolicy;
	/** Extension-managed storage root; skipped entirely when encountered. */
	storageRoot?: string;
	/** Hard stop on how many files to yield. */
	maxFiles?: number;
	/** Depth limit, mainly to bound pathological trees. */
	maxDepth?: number;
}

/**
 * Walk a workspace folder and yield candidate files.
 *
 * Excluded directories are pruned rather than entered, symbolic links are never
 * followed, and the extension's own storage is skipped so it cannot capture
 * itself recursively.
 */
export async function* walkFiles(options: WalkOptions): AsyncGenerator<ScannedFile> {
	const { rootDir, policy, maxFiles = Number.POSITIVE_INFINITY, maxDepth = 64 } = options;
	const storageRoot = options.storageRoot ? canonicalPathForIdentity(options.storageRoot) : undefined;
	let yielded = 0;

	async function* walk(dir: string, rel: string, depth: number): AsyncGenerator<ScannedFile> {
		if (depth > maxDepth || yielded >= maxFiles) {
			return;
		}
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			if (yielded >= maxFiles) {
				return;
			}
			const abs = path.join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;

			if (storageRoot && canonicalPathForIdentity(abs).startsWith(storageRoot)) {
				continue;
			}
			// Never follow symlinks: the target may live outside the workspace.
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				if (isExcludedDirectory(relPath, policy)) {
					continue;
				}
				yield* walk(abs, relPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const stat = await fs.stat(abs).catch(() => undefined);
			if (!stat || !stat.isFile()) {
				continue;
			}
			if (stat.size > policy.maxFileBytes) {
				continue;
			}
			yielded++;
			yield { absPath: abs, relPath, size: stat.size, mtimeMs: stat.mtimeMs };
		}
	}

	yield* walk(rootDir, '', 0);
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * completion order independence. Used for the bounded startup scan.
 */
export async function mapWithConcurrency<T, R>(
	items: Iterable<T> | AsyncIterable<T>,
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
	onItemDone?: (result: R, index: number) => void
): Promise<R[]> {
	const limit = Math.max(1, concurrency);
	const queue: T[] = [];
	if (Symbol.asyncIterator in Object(items)) {
		for await (const item of items as AsyncIterable<T>) {
			queue.push(item);
		}
	} else {
		for (const item of items as Iterable<T>) {
			queue.push(item);
		}
	}

	const results: R[] = new Array(queue.length);
	let nextIndex = 0;

	const runner = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex++;
			if (index >= queue.length) {
				return;
			}
			const result = await worker(queue[index], index);
			results[index] = result;
			onItemDone?.(result, index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => runner()));
	return results;
}
