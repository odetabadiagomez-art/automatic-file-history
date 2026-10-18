import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mapWithConcurrency, walkFiles } from '../../src/core/scan';
import { cleanupTempDirs, removeDir, tempDir, testPolicy, writeProjectFile } from './helpers';

describe('workspace scan', () => {
	let root: string;

	beforeEach(async () => {
		root = await tempDir('afh-scan-');
	});

	afterEach(async () => {
		await removeDir(root);
	});

	after(async () => {
		await cleanupTempDirs();
	});

	it('finds nested text files and reports workspace-relative paths', async () => {
		await writeProjectFile(root, 'notes.md', 'a');
		await writeProjectFile(root, 'src/deep/module.ts', 'b');
		await writeProjectFile(root, 'docs/plan final.md', 'c');

		const found: string[] = [];
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy() })) {
			found.push(file.relPath);
		}
		assert.deepEqual(found.sort(), ['docs/plan final.md', 'notes.md', 'src/deep/module.ts']);
	});

	it('prunes excluded directories instead of walking them', async () => {
		await writeProjectFile(root, 'src/app.ts', 'kept');
		await writeProjectFile(root, 'node_modules/pkg/index.js', 'skipped');
		await writeProjectFile(root, 'node_modules/pkg/deep/nested.js', 'skipped');
		await writeProjectFile(root, '.git/objects/x', 'skipped');
		await writeProjectFile(root, 'dist/bundle.js', 'skipped');

		const found: string[] = [];
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy() })) {
			found.push(file.relPath);
		}
		assert.deepEqual(found, ['src/app.ts']);
	});

	it('never follows symbolic links', async () => {
		const realDir = await tempDir('afh-scan-target-');
		await writeProjectFile(realDir, 'secret-outside.md', 'outside');
		await writeProjectFile(root, 'inside.md', 'inside');
		await fs.symlink(realDir, path.join(root, 'linked-dir'));
		await fs.symlink(path.join(realDir, 'secret-outside.md'), path.join(root, 'linked-file.md'));

		const found: string[] = [];
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy() })) {
			found.push(file.relPath);
		}
		assert.deepEqual(found, ['inside.md']);
		await removeDir(realDir);
	});

	it('respects the size limit and the file cap', async () => {
		await writeProjectFile(root, 'small.md', 'x'.repeat(10));
		await writeProjectFile(root, 'huge.md', 'x'.repeat(500));

		const limited: string[] = [];
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy({ maxFileBytes: 100 }) })) {
			limited.push(file.relPath);
		}
		assert.deepEqual(limited, ['small.md']);

		for (let i = 0; i < 10; i++) {
			await writeProjectFile(root, `many/f${i}.md`, 'x');
		}
		let count = 0;
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy(), maxFiles: 3 })) {
			void file;
			count++;
		}
		assert.equal(count, 3);
	});

	it('skips the extension storage folder even when it sits inside the tree', async () => {
		const storageRoot = path.join(root, '.afh-storage');
		await writeProjectFile(root, 'notes.md', 'kept');
		await fs.mkdir(path.join(storageRoot, 'blobs', 'ab'), { recursive: true });
		await fs.writeFile(path.join(storageRoot, 'blobs', 'ab', 'deadbeef'), 'blob');

		const found: string[] = [];
		for await (const file of walkFiles({ rootDir: root, policy: testPolicy(), storageRoot })) {
			found.push(file.relPath);
		}
		assert.deepEqual(found, ['notes.md']);
	});

	it('bounds concurrency and keeps result order', async () => {
		const items = Array.from({ length: 50 }, (_, index) => index);
		let inFlight = 0;
		let peak = 0;

		const results = await mapWithConcurrency(items, 4, async item => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inFlight--;
			return item * 2;
		});

		assert.deepEqual(results, items.map(item => item * 2));
		assert.ok(peak <= 4, `concurrency peaked at ${peak}`);
	});

	it('accepts an async iterable as input', async () => {
		async function* source(): AsyncGenerator<number> {
			yield 1;
			yield 2;
			yield 3;
		}
		const results = await mapWithConcurrency(source(), 2, async value => value + 1);
		assert.deepEqual(results, [2, 3, 4]);
	});
});
