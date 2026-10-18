import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sha256Hex } from '../../src/core/ids';
import {
	captureFile,
	cleanupTempDirs,
	createWorkspace,
	readHistory,
	removeDir,
	writeProjectFile,
	type TestWorkspace
} from './helpers';

describe('CaptureEngine', () => {
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

	it('captures an external write to a file that is not open in any editor', async () => {
		// This is the M0 proof: no editor, no save event, only a disk write.
		const abs = await writeProjectFile(workspace.root, 'unopened.md', '# written by an external tool');

		const outcome = await captureFile(workspace, 'unopened.md');

		assert.equal(outcome.kind, 'captured');
		assert.equal(outcome.seq, 1);
		assert.equal(outcome.hash, sha256Hex('# written by an external tool'));

		const history = await readHistory(workspace, 'unopened.md');
		assert.equal(history?.revisions.length, 1);
		const stored = await workspace.store.readBlob(history!.revisions[0].hash!);
		assert.equal(stored.toString(), '# written by an external tool');
		void abs;
	});

	it('records a baseline plus five acknowledged external revisions', async () => {
		await writeProjectFile(workspace.root, 'draft.md', 'baseline');
		const baseline = await captureFile(workspace, 'draft.md', { event: 'baseline', reconcile: true });
		assert.equal(baseline.event, 'baseline');

		for (let i = 1; i <= 5; i++) {
			await writeProjectFile(workspace.root, 'draft.md', `revision ${i}`);
			const outcome = await captureFile(workspace, 'draft.md');
			assert.equal(outcome.kind, 'captured', `revision ${i} should be captured`);
			assert.equal(outcome.seq, i + 1);
		}

		const history = await readHistory(workspace, 'draft.md');
		assert.equal(history?.revisions.length, 6);
		const contents: string[] = [];
		for (const revision of history!.revisions) {
			contents.push((await workspace.store.readBlob(revision.hash!)).toString());
		}
		assert.deepEqual(contents, ['baseline', 'revision 1', 'revision 2', 'revision 3', 'revision 4', 'revision 5']);
	});

	it('stores one revision when a save and a watcher event report the same state', async () => {
		await writeProjectFile(workspace.root, 'both.md', 'same state');

		const save = await captureFile(workspace, 'both.md', { event: 'editor-save', origin: 'editor' });
		const watch = await captureFile(workspace, 'both.md', { event: 'disk-change', origin: 'unknown' });

		assert.equal(save.kind, 'captured');
		assert.equal(watch.kind, 'unchanged', 'a duplicate trigger must not create a second entry');

		const history = await readHistory(workspace, 'both.md');
		assert.equal(history?.revisions.length, 1);
		assert.equal(history?.revisions[0].event, 'editor-save');
		assert.equal(history?.revisions[0].origin, 'editor');
	});

	it('eventually captures the latest state after a rapid unacknowledged burst', async () => {
		const abs = await writeProjectFile(workspace.root, 'burst.txt', 'v0');
		await captureFile(workspace, 'burst.txt');

		// Fire writes and captures without awaiting each write, the way a fast
		// external tool would. Intermediate states may legitimately be missed.
		const pending: Promise<unknown>[] = [];
		for (let i = 1; i <= 8; i++) {
			await fs.writeFile(abs, `v${i}`);
			pending.push(captureFile(workspace, 'burst.txt'));
		}
		await Promise.all(pending);

		const history = await readHistory(workspace, 'burst.txt');
		assert.ok(history);
		const latest = history.revisions[history.revisions.length - 1];
		const content = await workspace.store.readBlob(latest.hash!);
		assert.equal(content.toString(), 'v8', 'the final state must be captured');
		assert.ok(history.revisions.length >= 2);
	});

	it('coalesces concurrent requests for one file into a single pass', async () => {
		await writeProjectFile(workspace.root, 'concurrent.txt', 'content');

		const results = await Promise.all([
			captureFile(workspace, 'concurrent.txt'),
			captureFile(workspace, 'concurrent.txt'),
			captureFile(workspace, 'concurrent.txt')
		]);

		// All callers share the outcome of the single pass that covered them.
		assert.equal(new Set(results.map(result => result.seq)).size, 1, 'one pass, one acknowledgement');
		assert.equal(results[0].kind, 'captured');
		const history = await readHistory(workspace, 'concurrent.txt');
		assert.equal(history?.revisions.length, 1, 'one state, one revision');
	});

	it('serialises work per file but allows different files to proceed together', async () => {
		await writeProjectFile(workspace.root, 'a.txt', 'a');
		await writeProjectFile(workspace.root, 'b.txt', 'b');

		const results = await Promise.all([
			captureFile(workspace, 'a.txt'),
			captureFile(workspace, 'b.txt')
		]);
		assert.deepEqual(
			results.map(result => result.kind),
			['captured', 'captured']
		);
		assert.equal((await readHistory(workspace, 'a.txt'))?.revisions.length, 1);
		assert.equal((await readHistory(workspace, 'b.txt'))?.revisions.length, 1);
	});

	it('captures the final content after an atomic temporary-file replacement', async () => {
		const abs = await writeProjectFile(workspace.root, 'atomic.txt', 'before');
		await captureFile(workspace, 'atomic.txt');

		const tmp = `${abs}.tmp-replacement`;
		await fs.writeFile(tmp, 'after atomic replacement');
		await fs.rename(tmp, abs);

		const outcome = await captureFile(workspace, 'atomic.txt');
		assert.equal(outcome.kind, 'captured');

		const history = await readHistory(workspace, 'atomic.txt');
		assert.equal(history?.revisions.length, 2);
		assert.equal(
			(await workspace.store.readBlob(history!.revisions[0].hash!)).toString(),
			'before',
			'the prior snapshot is preserved'
		);
		assert.equal(
			(await workspace.store.readBlob(history!.revisions[1].hash!)).toString(),
			'after atomic replacement'
		);
	});

	it('captures the initial content of a newly created file', async () => {
		const abs = path.join(workspace.root, 'brand-new.txt');
		const missing = await captureFile(workspace, 'brand-new.txt');
		assert.equal(missing.kind, 'skipped', 'nothing exists yet and nothing was captured before');
		assert.equal(missing.skipReason, 'missing');

		await fs.writeFile(abs, 'created externally');
		const created = await captureFile(workspace, 'brand-new.txt', { event: 'created' });
		assert.equal(created.kind, 'captured');
		assert.equal(created.event, 'created');
	});

	it('keeps earlier snapshots discoverable after a delete, and captures a reappearance', async () => {
		const abs = await writeProjectFile(workspace.root, 'doomed.txt', 'precious');
		await captureFile(workspace, 'doomed.txt');

		await fs.unlink(abs);
		const deleted = await captureFile(workspace, 'doomed.txt');
		assert.equal(deleted.kind, 'deleted');

		let history = await readHistory(workspace, 'doomed.txt');
		assert.ok(history);
		assert.equal(history.deleted, true);
		assert.equal(history.revisions.length, 2);
		const recovered = await workspace.store.readBlob(history.revisions[0].hash!);
		assert.equal(recovered.toString(), 'precious');

		await fs.writeFile(abs, 'back again');
		const recreated = await captureFile(workspace, 'doomed.txt', { event: 'created' });
		assert.equal(recreated.kind, 'captured');

		history = await readHistory(workspace, 'doomed.txt');
		assert.equal(history?.deleted, false);
		assert.equal(history?.revisions.length, 3);
		assert.equal(
			(await workspace.store.readBlob(history!.revisions[2].hash!)).toString(),
			'back again'
		);
	});

	it('handles Unicode and spaced paths', async () => {
		const relPath = 'документы/отчёт итоговый — final ✅.md';
		await writeProjectFile(workspace.root, relPath, 'unicode content');

		const outcome = await captureFile(workspace, relPath);
		assert.equal(outcome.kind, 'captured');

		const history = await workspace.store.getHistoryByPath(path.join(workspace.root, relPath));
		assert.ok(history);
		assert.equal(history.relPath, relPath);
		assert.equal((await workspace.store.readBlob(history.revisions[0].hash!)).toString(), 'unicode content');
	});

	it('captures multi-byte content byte-exactly', async () => {
		const content = 'héllo — 世界 🎬\nsecond line';
		await writeProjectFile(workspace.root, 'unicode-body.txt', content);
		const outcome = await captureFile(workspace, 'unicode-body.txt');
		assert.equal(outcome.kind, 'captured');
		assert.equal(outcome.size, Buffer.byteLength(content));
		const history = await readHistory(workspace, 'unicode-body.txt');
		assert.equal((await workspace.store.readBlob(history!.revisions[0].hash!)).toString(), content);
	});

	it('skips an oversized file with an accurate explanation', async () => {
		const small = await createWorkspace({ maxFileBytes: 32 });
		try {
			await writeProjectFile(small.root, 'big.txt', 'x'.repeat(64));
			const outcome = await captureFile(small, 'big.txt');
			assert.equal(outcome.kind, 'skipped');
			assert.equal(outcome.skipReason, 'too-large');
			assert.match(outcome.reason ?? '', /32 B/);
			assert.equal(await readHistory(small, 'big.txt'), null);
		} finally {
			await removeDir(small.storageRoot);
			await removeDir(small.root);
		}
	});

	it('skips binary content instead of storing it as text', async () => {
		await writeProjectFile(workspace.root, 'image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
		const png = await captureFile(workspace, 'image.png');
		assert.equal(png.kind, 'skipped');
		assert.equal(png.skipReason, 'binary');

		// A NUL byte disqualifies content even when the extension is unknown.
		await writeProjectFile(workspace.root, 'payload.dat', Buffer.from([0x41, 0x00, 0x42]));
		const nul = await captureFile(workspace, 'payload.dat');
		assert.equal(nul.kind, 'skipped');
		assert.equal(nul.skipReason, 'binary');
		assert.match(nul.reason ?? '', /NUL/);

		// Invalid UTF-8 is reported separately from NUL detection.
		await writeProjectFile(workspace.root, 'latin1.dat', Buffer.from([0xff, 0xfe, 0x61, 0x62]));
		const invalid = await captureFile(workspace, 'latin1.dat');
		assert.equal(invalid.kind, 'skipped');
		assert.equal(invalid.skipReason, 'binary');
		assert.match(invalid.reason ?? '', /UTF-8/);
	});

	it('skips excluded paths, including secrets, and names the pattern', async () => {
		const cases: Array<[string, string]> = [
			['node_modules/pkg/index.js', 'export {}'],
			['.env', 'API_KEY=secret'],
			['config/.env.local', 'API_KEY=secret'],
			['dist/bundle.js', 'bundled'],
			['.git/config', '[core]'],
			['keys/private.pem', '-----BEGIN PRIVATE KEY-----'],
			['secrets.json', '{}']
		];
		for (const [relPath, content] of cases) {
			await writeProjectFile(workspace.root, relPath, content);
			const outcome = await captureFile(workspace, relPath);
			assert.equal(outcome.kind, 'skipped', `${relPath} should be skipped`);
			assert.equal(outcome.skipReason, 'excluded', `${relPath} reason`);
			assert.match(outcome.reason ?? '', /Excluded by pattern/);
			assert.equal(await workspace.store.getHistoryByPath(path.join(workspace.root, relPath)), null);
		}
	});

	it('honours a user include that overrides a default exclusion', async () => {
		const included = await createWorkspace({ includeGlobs: ['**/.env.example'] });
		try {
			await writeProjectFile(included.root, '.env.example', 'PUBLIC_VALUE=1');
			const outcome = await captureFile(included, '.env.example');
			assert.equal(outcome.kind, 'captured');
		} finally {
			await removeDir(included.storageRoot);
			await removeDir(included.root);
		}
	});

	it('honours a user exclusion that beats an include', async () => {
		const custom = await createWorkspace({
			excludeGlobs: ['**/private/**'],
			includeGlobs: ['**/private/keep.md']
		});
		try {
			await writeProjectFile(custom.root, 'private/keep.md', 'no');
			const outcome = await captureFile(custom, 'private/keep.md');
			assert.equal(outcome.kind, 'skipped');
			assert.equal(outcome.skipReason, 'excluded');
		} finally {
			await removeDir(custom.storageRoot);
			await removeDir(custom.root);
		}
	});

	it('skips symbolic links', async () => {
		const target = await writeProjectFile(workspace.root, 'real.txt', 'real');
		await fs.symlink(target, path.join(workspace.root, 'link.txt'));

		const outcome = await captureFile(workspace, 'link.txt');
		assert.equal(outcome.kind, 'skipped');
		assert.equal(outcome.skipReason, 'symlink');
	});

	it('reports a capture failure explicitly instead of claiming success', async () => {
		const abs = await writeProjectFile(workspace.root, 'locked.txt', 'cannot read');
		await fs.chmod(abs, 0o000);
		try {
			const outcome = await captureFile(workspace, 'locked.txt');
			assert.equal(outcome.kind, 'failed');
			assert.match(outcome.error ?? '', /EACCES|permission/i);
			assert.equal(await readHistory(workspace, 'locked.txt'), null, 'no phantom revision');
		} finally {
			await fs.chmod(abs, 0o644);
		}
	});

	it('never captures anything inside its own storage', async () => {
		const inside = path.join(workspace.store.rootDir, 'files', 'anything.json');
		await fs.mkdir(path.dirname(inside), { recursive: true });
		await fs.writeFile(inside, '{}');

		const outcome = await workspace.engine.capture({
			path: inside,
			relPath: 'anything.json',
			event: 'disk-change',
			origin: 'unknown'
		});
		assert.equal(outcome.kind, 'skipped');
		assert.equal(outcome.skipReason, 'extension-storage');
	});

	it('labels reconciled states as baseline or observed-on-startup', async () => {
		await writeProjectFile(workspace.root, 'restart.txt', 'before downtime');
		const first = await captureFile(workspace, 'restart.txt', { event: 'baseline', reconcile: true });
		assert.equal(first.kind, 'captured');
		assert.equal(first.event, 'baseline');

		// Same state on "restart": nothing new is stored.
		const unchanged = await captureFile(workspace, 'restart.txt', { event: 'baseline', reconcile: true });
		assert.equal(unchanged.kind, 'unchanged');

		// A change that happened while monitoring was off.
		await writeProjectFile(workspace.root, 'restart.txt', 'changed while closed');
		const diverged = await captureFile(workspace, 'restart.txt', { event: 'baseline', reconcile: true });
		assert.equal(diverged.kind, 'captured');
		assert.equal(diverged.event, 'observed-on-startup');

		const history = await readHistory(workspace, 'restart.txt');
		assert.equal(history?.revisions.length, 2);
		assert.deepEqual(
			history?.revisions.map(revision => revision.event),
			['baseline', 'observed-on-startup']
		);
	});

	it('applies an explicit label to the next captured state (restore path)', async () => {
		await writeProjectFile(workspace.root, 'restore-me.txt', 'original');
		await captureFile(workspace, 'restore-me.txt');

		workspace.engine.setNextCaptureLabel(path.join(workspace.root, 'restore-me.txt'), {
			event: 'restored',
			origin: 'editor',
			note: 'Restored from snapshot #1.'
		});
		await writeProjectFile(workspace.root, 'restore-me.txt', 'original');
		await fs.utimes(path.join(workspace.root, 'restore-me.txt'), new Date(), new Date());
		await writeProjectFile(workspace.root, 'restore-me.txt', 'restored content');

		const outcome = await captureFile(workspace, 'restore-me.txt', { event: 'editor-save', origin: 'editor' });
		assert.equal(outcome.kind, 'captured');
		assert.equal(outcome.event, 'restored');

		const history = await readHistory(workspace, 'restore-me.txt');
		assert.equal(history?.revisions[1].event, 'restored');
		assert.equal(history?.revisions[1].note, 'Restored from snapshot #1.');
	});

	it('stays quiet while paused and resumes afterwards', async () => {
		await writeProjectFile(workspace.root, 'paused.txt', 'v1');
		workspace.engine.setPaused(true);

		const whilePaused = await captureFile(workspace, 'paused.txt');
		assert.equal(whilePaused.kind, 'skipped');
		assert.equal(await readHistory(workspace, 'paused.txt'), null);

		workspace.engine.setPaused(false);
		await writeProjectFile(workspace.root, 'paused.txt', 'v2');
		const afterResume = await captureFile(workspace, 'paused.txt');
		assert.equal(afterResume.kind, 'captured');
		const history = await readHistory(workspace, 'paused.txt');
		assert.equal((await workspace.store.readBlob(history!.revisions[0].hash!)).toString(), 'v2');
	});
});
