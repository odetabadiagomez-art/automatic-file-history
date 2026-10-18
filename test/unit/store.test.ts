import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { blobRelativePath, sha256Hex } from '../../src/core/ids';
import { HistoryStore } from '../../src/core/store';
import {
	captureFile,
	cleanupTempDirs,
	createWorkspace,
	readHistory,
	removeDir,
	tempDir,
	testPolicy,
	writeProjectFile,
	type TestWorkspace
} from './helpers';

describe('HistoryStore', () => {
	let workspace: TestWorkspace;

	beforeEach(async () => {
		workspace = await createWorkspace();
	});

	afterEach(async () => {
		await removeDir(workspace.storageRoot);
		await removeDir(workspace.root);
	});

	after(async () => {
		await cleanupTempDirs();
	});

	it('creates its storage layout outside the project with owner-only permissions', async () => {
		const stat = await fs.stat(workspace.store.rootDir);
		assert.ok(stat.isDirectory());
		assert.ok(!workspace.store.rootDir.startsWith(workspace.root), 'storage must not live in the project');
		for (const name of ['files', 'blobs']) {
			const dirStat = await fs.stat(path.join(workspace.store.rootDir, name));
			assert.equal(dirStat.mode & 0o777, 0o700, `${name} should be 0700`);
		}
	});

	it('stores a baseline and deduplicates identical consecutive content', async () => {
		await writeProjectFile(workspace.root, 'notes.md', 'first');
		const first = await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'notes.md'),
			relPath: 'notes.md',
			content: Buffer.from('first'),
			event: 'baseline',
			origin: 'unknown'
		});
		assert.equal(first.kind, 'captured');
		assert.equal(first.seq, 1);

		const same = await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'notes.md'),
			relPath: 'notes.md',
			content: Buffer.from('first'),
			event: 'disk-change',
			origin: 'unknown'
		});
		assert.equal(same.kind, 'unchanged', 'identical content must not create a second revision');

		const second = await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'notes.md'),
			relPath: 'notes.md',
			content: Buffer.from('second'),
			event: 'disk-change',
			origin: 'unknown'
		});
		assert.equal(second.kind, 'captured');
		assert.equal(second.seq, 2);
	});

	it('represents A -> B -> A as three ordered states', async () => {
		const abs = await writeProjectFile(workspace.root, 'a.txt', 'A');
		const append = (content: string) =>
			workspace.store.appendContent({
				absPath: abs,
				relPath: 'a.txt',
				content: Buffer.from(content),
				event: 'disk-change',
				origin: 'unknown'
			});

		await append('A');
		await append('B');
		await append('A');

		const history = await readHistory(workspace, 'a.txt');
		assert.ok(history);
		assert.deepEqual(
			history.revisions.map(revision => revision.hash),
			[sha256Hex('A'), sha256Hex('B'), sha256Hex('A')],
			'returning to an older state is a new history event'
		);
		assert.deepEqual(history.revisions.map(revision => revision.seq), [1, 2, 3]);
	});

	it('shares one blob between files with identical content', async () => {
		const shared = 'shared content';
		await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'one.txt'),
			relPath: 'one.txt',
			content: Buffer.from(shared),
			event: 'baseline',
			origin: 'unknown'
		});
		await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'two.txt'),
			relPath: 'two.txt',
			content: Buffer.from(shared),
			event: 'baseline',
			origin: 'unknown'
		});

		const usage = await workspace.store.usage();
		assert.equal(usage.blobCount, 1, 'content-addressed storage must deduplicate');
		assert.equal(usage.fileCount, 2);
	});

	it('rejects a damaged blob instead of returning wrong content', async () => {
		const content = Buffer.from('important');
		const { hash } = await workspace.store.writeBlob(content);
		const blobPath = path.join(workspace.store.rootDir, blobRelativePath(hash));

		const originalMode = (await fs.stat(blobPath)).mode;
		await fs.chmod(blobPath, 0o600);
		await fs.writeFile(blobPath, Buffer.from('tampered!'));
		await fs.chmod(blobPath, originalMode);

		await assert.rejects(() => workspace.store.readBlob(hash), /integrity check/);
	});

	it('refuses to read a hash that was never stored', async () => {
		await assert.rejects(() => workspace.store.readBlob('a'.repeat(64)), /ENOENT|no such file/i);
		await assert.rejects(() => workspace.store.readBlob('not-a-hash'), /invalid hash/);
	});

	it('keeps earlier snapshots after a deletion and records the delete marker', async () => {
		const abs = await writeProjectFile(workspace.root, 'gone.txt', 'content');
		await workspace.store.appendContent({
			absPath: abs,
			relPath: 'gone.txt',
			content: Buffer.from('content'),
			event: 'baseline',
			origin: 'unknown'
		});
		await fs.unlink(abs);

		const result = await workspace.store.markDeleted({ absPath: abs, relPath: 'gone.txt' });
		assert.equal(result.kind, 'deleted');

		const history = await readHistory(workspace, 'gone.txt');
		assert.ok(history);
		assert.equal(history.deleted, true);
		assert.equal(history.revisions.length, 2);
		assert.equal(history.revisions[1].event, 'deleted');
		assert.equal(history.revisions[1].hash, '');

		const recovered = await workspace.store.readBlob(history.revisions[0].hash!);
		assert.equal(recovered.toString(), 'content', 'deleted files must stay recoverable');
	});

	it('does not invent a delete record for a file it never captured', async () => {
		const result = await workspace.store.markDeleted({
			absPath: path.join(workspace.root, 'never-seen.txt'),
			relPath: 'never-seen.txt'
		});
		assert.equal(result.kind, 'unchanged');
		assert.equal(await readHistory(workspace, 'never-seen.txt'), null);
	});

	it('prunes the oldest revisions but keeps the baseline and the latest state', async () => {
		const narrow = await createWorkspace({ maxRevisionsPerFile: 4 });
		try {
			const abs = await writeProjectFile(narrow.root, 'churn.txt', 'v0');
			for (let i = 0; i < 10; i++) {
				await narrow.store.appendContent({
					absPath: abs,
					relPath: 'churn.txt',
					content: Buffer.from(`v${i}`),
					event: 'disk-change',
					origin: 'unknown'
				});
			}
			const history = await readHistory(narrow, 'churn.txt');
			assert.ok(history);
			assert.equal(history.revisions.length, 4);
			assert.equal(history.revisions[0].hash, sha256Hex('v0'), 'baseline is preserved');
			assert.equal(history.revisions[3].hash, sha256Hex('v9'), 'latest state is preserved');
			assert.equal(history.pruned, 6);
			assert.equal(history.nextSeq, 11, 'sequence numbers never restart');
		} finally {
			await removeDir(narrow.storageRoot);
			await removeDir(narrow.root);
		}
	});

	it('moves history on a rename and never merges into an existing record', async () => {
		const from = await writeProjectFile(workspace.root, 'old.txt', 'content');
		await workspace.store.appendContent({
			absPath: from,
			relPath: 'old.txt',
			content: Buffer.from('content'),
			event: 'baseline',
			origin: 'unknown'
		});

		const to = path.join(workspace.root, 'new.txt');
		const moved = await workspace.store.recordRename(from, to, 'new.txt', 'test-workspace');
		assert.equal(moved, true);

		const history = await workspace.store.getHistoryByPath(to);
		assert.ok(history, 'history follows the new path');
		assert.deepEqual(history.renamedFrom, [from]);
		assert.equal(await workspace.store.getHistoryByPath(from), null);

		// A rename onto a path that already has history must not merge or lose data.
		const other = await writeProjectFile(workspace.root, 'other.txt', 'other');
		await workspace.store.appendContent({
			absPath: other,
			relPath: 'other.txt',
			content: Buffer.from('other'),
			event: 'baseline',
			origin: 'unknown'
		});
		const refused = await workspace.store.recordRename(to, other, 'other.txt', 'test-workspace');
		assert.equal(refused, false);
		assert.ok(await workspace.store.getHistoryByPath(to), 'source history is untouched');
		const otherHistory = await workspace.store.getHistoryByPath(other);
		assert.equal(otherHistory?.revisions.length, 1, 'destination history is untouched');
	});

	it('reports no rename when there is no history to move', async () => {
		const moved = await workspace.store.recordRename(
			path.join(workspace.root, 'unknown.txt'),
			path.join(workspace.root, 'other.txt'),
			'other.txt'
		);
		assert.equal(moved, false);
	});

	it('frees only unreferenced blobs when one file history is deleted', async () => {
		const shared = 'identical bytes';
		await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'keep.txt'),
			relPath: 'keep.txt',
			content: Buffer.from(shared),
			event: 'baseline',
			origin: 'unknown'
		});
		await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'drop.txt'),
			relPath: 'drop.txt',
			content: Buffer.from(shared),
			event: 'baseline',
			origin: 'unknown'
		});
		await workspace.store.appendContent({
			absPath: path.join(workspace.root, 'drop.txt'),
			relPath: 'drop.txt',
			content: Buffer.from('unique bytes'),
			event: 'disk-change',
			origin: 'unknown'
		});

		const result = await workspace.store.deleteHistoryByPath(path.join(workspace.root, 'drop.txt'));
		assert.equal(result.removedRevisions, 2);

		const stillReadable = await workspace.store.readBlob(sha256Hex(shared));
		assert.equal(stillReadable.toString(), shared, 'shared blob must survive');
		assert.equal(await workspace.store.hasBlob(sha256Hex('unique bytes')), false);
	});

	it('garbage collects orphaned blobs but respects the grace period', async () => {
		const { hash } = await workspace.store.writeBlob(Buffer.from('orphan'));
		assert.equal(await workspace.store.hasBlob(hash), true);

		const fresh = await workspace.store.gc({ graceMs: 60_000 });
		assert.equal(fresh.removedBlobs, 0, 'a blob another window may be about to reference is kept');
		assert.equal(await workspace.store.hasBlob(hash), true);

		const collected = await workspace.store.gc({ graceMs: 0 });
		assert.equal(collected.removedBlobs, 1);
		assert.equal(collected.freedBytes, Buffer.byteLength('orphan'));
		assert.equal(await workspace.store.hasBlob(hash), false);
	});

	it('never publishes a revision that points at missing content after a crash between writes', async () => {
		// Simulate the crash window: blob written, manifest never published.
		const { hash } = await workspace.store.writeBlob(Buffer.from('crash window'));
		const collected = await workspace.store.gc({ graceMs: 0 });
		assert.equal(collected.removedBlobs, 1);

		const summaries = await workspace.store.listSummaries();
		for (const summary of summaries) {
			const history = await workspace.store.getFileHistory(summary.fileId);
			for (const revision of history?.revisions ?? []) {
				if (revision.hash) {
					assert.equal(await workspace.store.hasBlob(revision.hash), true, 'dangling reference published');
				}
			}
		}
		assert.equal(await workspace.store.hasBlob(hash), false);
	});

	it('prunes across files when the workspace budget is exceeded', async () => {
		const tiny = await createWorkspace({
			workspaceBudgetBytes: 120,
			maxRevisionsPerFile: 100
		});
		try {
			for (const name of ['a.txt', 'b.txt']) {
				const abs = await writeProjectFile(tiny.root, name, `${name}-0`);
				for (let i = 0; i < 6; i++) {
					await tiny.store.appendContent({
						absPath: abs,
						relPath: name,
						content: Buffer.from(`${name}-${i}-${'x'.repeat(20)}`),
						event: 'disk-change',
						origin: 'unknown'
					});
				}
			}
			// Budget pressure is applied automatically as revisions are appended.
			await tiny.store.gc({ graceMs: 0 });
			const afterAutomatic = await tiny.store.usage();
			assert.ok(
				afterAutomatic.blobBytes <= 160,
				`automatic retention should bring storage near the budget, got ${afterAutomatic.blobBytes}`
			);
			assert.ok(afterAutomatic.prunedRevisions > 0, 'budget pressure must prune something');

			// Once compliant, an explicit pass is a documented no-op.
			const explicit = await tiny.store.enforceBudget();
			assert.equal(explicit.prunedRevisions, 0);

			for (const name of ['a.txt', 'b.txt']) {
				const history = await tiny.store.getHistoryByPath(path.join(tiny.root, name));
				assert.ok(history);
				const latest = history.revisions[history.revisions.length - 1];
				assert.ok(latest.hash, 'the latest state always keeps its content');
				const content = await tiny.store.readBlob(latest.hash);
				assert.equal(content.toString(), `${name}-5-${'x'.repeat(20)}`);
				assert.equal(
					history.revisions[0].hash,
					sha256Hex(`${name}-0-${'x'.repeat(20)}`),
					'baseline is preserved'
				);
			}
			const usage = await tiny.store.usage();
			assert.ok(usage.blobBytes <= 200, `budget should be roughly respected, got ${usage.blobBytes}`);
		} finally {
			await removeDir(tiny.storageRoot);
			await removeDir(tiny.root);
		}
	});

	it('keeps two windows on the same workspace from losing each other’s revisions', async () => {
		// Two store instances over one directory model two VS Code windows.
		const second = await HistoryStore.open({
			rootDir: workspace.store.rootDir,
			workspaceId: 'test-workspace',
			policy: workspace.policy
		});

		const abs = await writeProjectFile(workspace.root, 'shared.txt', 'start');
		await workspace.store.appendContent({
			absPath: abs,
			relPath: 'shared.txt',
			content: Buffer.from('start'),
			event: 'baseline',
			origin: 'unknown'
		});

		const writers = Array.from({ length: 12 }, (_, index) => {
			const store = index % 2 === 0 ? workspace.store : second;
			return store.appendContent({
				absPath: abs,
				relPath: 'shared.txt',
				content: Buffer.from(`state-${index}`),
				event: 'disk-change',
				origin: 'unknown'
			});
		});
		const results = await Promise.all(writers);

		const history = await readHistory(workspace, 'shared.txt');
		assert.ok(history);
		const captured = results.filter(result => result.kind === 'captured');
		assert.equal(
			history.revisions.length,
			captured.length + 1,
			'every acknowledged capture must be present exactly once'
		);
		const seqs = history.revisions.map(revision => revision.seq);
		assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'sequence numbers stay monotonic');
		assert.equal(new Set(seqs).size, seqs.length, 'no duplicate sequence numbers');

		for (const revision of history.revisions) {
			if (revision.hash) {
				assert.equal(await workspace.store.hasBlob(revision.hash), true);
			}
		}
	});

	it('survives a reopen: persisted revisions are still readable', async () => {
		const abs = await writeProjectFile(workspace.root, 'persist.txt', 'kept');
		await captureFile(workspace, 'persist.txt');

		const reopened = await HistoryStore.open({
			rootDir: workspace.store.rootDir,
			workspaceId: 'test-workspace',
			policy: workspace.policy
		});
		const history = await reopened.getHistoryByPath(abs);
		assert.ok(history);
		assert.equal(history.revisions.length, 1);
		const content = await reopened.readBlob(history.revisions[0].hash!);
		assert.equal(content.toString(), 'kept');
	});

	it('clears every revision for the workspace', async () => {
		await writeProjectFile(workspace.root, 'x.txt', 'x');
		await captureFile(workspace, 'x.txt');
		await writeProjectFile(workspace.root, 'x.txt', 'y');
		await captureFile(workspace, 'x.txt');

		await workspace.store.clearWorkspace();
		const usage = await workspace.store.usage();
		assert.equal(usage.fileCount, 0);
		assert.equal(usage.blobCount, 0);
		assert.equal(usage.blobBytes, 0);
	});

	it('lists summaries newest activity first and flags deleted files', async () => {
		await writeProjectFile(workspace.root, 'old.txt', 'old');
		await captureFile(workspace, 'old.txt');
		await writeProjectFile(workspace.root, 'new.txt', 'new');
		await captureFile(workspace, 'new.txt');

		const deleted = path.join(workspace.root, 'old.txt');
		await fs.unlink(deleted);
		await workspace.store.markDeleted({ absPath: deleted, relPath: 'old.txt' });

		const summaries = await workspace.store.listSummaries();
		assert.equal(summaries.length, 2);
		assert.equal(summaries[0].relPath, 'old.txt', 'most recent activity sorts first');
		assert.equal(summaries[0].deleted, true);
		assert.equal(summaries[1].relPath, 'new.txt');
		assert.equal(summaries[1].revisionCount, 1);
	});

	it('ignores a corrupt manifest instead of failing the whole list', async () => {
		await writeProjectFile(workspace.root, 'good.txt', 'good');
		await captureFile(workspace, 'good.txt');
		const filesDir = path.join(workspace.store.rootDir, 'files');
		await fs.writeFile(path.join(filesDir, 'bogus-id.json'), '{ not json');

		const summaries = await workspace.store.listSummaries();
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].relPath, 'good.txt');
	});
});

describe('WorkspaceLock', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await tempDir('afh-lock-');
	});

	afterEach(async () => {
		await removeDir(dir);
	});

	it('serialises competing stores and reclaims an abandoned lock', async () => {
		const policy = testPolicy();
		const first = await HistoryStore.open({
			rootDir: dir,
			workspaceId: 'lock-test',
			policy
		});
		const second = await HistoryStore.open({
			rootDir: dir,
			workspaceId: 'lock-test',
			policy
		});

		const abs = path.join(dir, 'file.txt');
		await fs.writeFile(abs, 'start');

		// A lock left behind by a process that already exited must not deadlock
		// the workspace, even though it is not stale by age yet.
		const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid ?? 99_999;
		const lockPath = path.join(dir, 'lock');
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				pid: deadPid,
				hostname: os.hostname(),
				token: 'stale',
				startedAt: new Date().toISOString()
			})
		);

		const results = await Promise.all([
			first.appendContent({
				absPath: abs,
				relPath: 'file.txt',
				content: Buffer.from('one'),
				event: 'baseline',
				origin: 'unknown'
			}),
			second.appendContent({
				absPath: abs,
				relPath: 'file.txt',
				content: Buffer.from('two'),
				event: 'disk-change',
				origin: 'unknown'
			})
		]);
		assert.equal(results.filter(result => result.kind === 'captured').length, 2);

		const history = await first.getHistoryByPath(abs);
		assert.equal(history?.revisions.length, 2);
	});
});
