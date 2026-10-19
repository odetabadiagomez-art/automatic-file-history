import * as assert from 'node:assert/strict';
import {
	DEFAULT_EXCLUDES,
	classifyContent,
	evaluateEligibility,
	findExclusion,
	formatBytes,
	isExcludedDirectory,
	isLikelyValidUtf8,
	skipExplanation
} from '../../src/core/eligibility';
import { testPolicy } from './helpers';

const policy = testPolicy();

function evaluate(relPath: string, overrides: Partial<Parameters<typeof evaluateEligibility>[0]> = {}) {
	return evaluateEligibility({
		absPath: `/workspace/${relPath}`,
		relPath,
		size: 100,
		isSymbolicLink: false,
		isDirectory: false,
		policy,
		...overrides
	});
}

describe('eligibility', () => {
	it('accepts ordinary text and source files', () => {
		for (const relPath of [
			'notes.md',
			'src/index.ts',
			'docs/deep/nested/plan.md',
			'package.json',
			'script.sh',
			'README',
			'Отчёт final ✅.md'
		]) {
			assert.equal(evaluate(relPath).eligible, true, relPath);
		}
	});

	it('excludes dependency, build and version-control trees', () => {
		for (const relPath of [
			'node_modules/pkg/index.js',
			'a/b/node_modules/x.js',
			'.git/config',
			'.file-history/files/abc.json',
			'.file-history/blobs/ab/def',
			'dist/bundle.js',
			'build/output.o',
			'out/compiled.js',
			'__pycache__/mod.pyc',
			'.venv/lib/site.py',
			'coverage/lcov.info',
			'.next/cache/x'
		]) {
			const result = evaluate(relPath);
			assert.equal(result.eligible, false, relPath);
			assert.equal(result.reason, 'excluded', relPath);
		}
	});

	it('excludes likely secrets by default and says so', () => {
		for (const relPath of ['.env', '.env.local', 'config/.env.production', 'keys/id_rsa', 'cert.pem', 'app.key']) {
			const result = evaluate(relPath);
			assert.equal(result.eligible, false, relPath);
			assert.equal(result.reason, 'excluded', relPath);
			assert.match(result.detail ?? '', /Excluded by pattern/);
		}
		assert.ok(DEFAULT_EXCLUDES.some(pattern => pattern === '**/.env.*'));
	});

	it('lets a user include rescue a default exclusion but not a user exclusion', () => {
		assert.equal(findExclusion('.env.example', testPolicy({ includeGlobs: ['**/.env.example'] })).excluded, false);
		assert.equal(
			findExclusion('private/notes.md', testPolicy({ excludeGlobs: ['**/private/**'], includeGlobs: ['**/private/**'] }))
				.excluded,
			true
		);
	});

	it('reports the matching pattern and whether it came from user settings', () => {
		const userExclude = findExclusion('generated/api.ts', testPolicy({ excludeGlobs: ['**/generated/**'] }));
		assert.equal(userExclude.excluded, true);
		assert.equal(userExclude.source, 'user-exclude');

		const defaultExclude = findExclusion('node_modules/a/index.js', policy);
		assert.equal(defaultExclude.source, 'default');
	});

	it('prunes excluded directories during a walk', () => {
		assert.equal(isExcludedDirectory('node_modules', policy), true);
		assert.equal(isExcludedDirectory('packages/app/node_modules', policy), true);
		assert.equal(isExcludedDirectory('.git', policy), true);
		assert.equal(isExcludedDirectory('src', policy), false);
		assert.equal(isExcludedDirectory('src/generated', testPolicy({ excludeGlobs: ['**/generated/**'] })), true);
	});

	it('rejects files above the size limit', () => {
		const result = evaluate('big.md', { size: 5 * 1024 * 1024 });
		assert.equal(result.eligible, false);
		assert.equal(result.reason, 'too-large');
		assert.match(result.detail ?? '', /2\.0 MiB/);
	});

	it('rejects symlinks, directories and extension storage', () => {
		assert.equal(evaluate('link.md', { isSymbolicLink: true }).reason, 'symlink');
		assert.equal(evaluate('dir', { isDirectory: true }).reason, 'not-a-file');
		assert.equal(
			evaluate('blob', { absPath: '/storage/root/blobs/ab/x', storageRoot: '/storage/root' }).reason,
			'extension-storage'
		);
	});

	it('detects binary content by NUL byte and by invalid UTF-8', () => {
		assert.equal(classifyContent(Buffer.from([0x41, 0x00, 0x42])), 'binary');
		assert.equal(classifyContent(Buffer.from('plain text')), 'text');
		assert.equal(isLikelyValidUtf8(Buffer.from('héllo 世界')), true);
		assert.equal(isLikelyValidUtf8(Buffer.from([0xff, 0xfe, 0xfd])), false);

		const binary = evaluate('data.bin', { sample: Buffer.from([0x41, 0x00]) });
		assert.equal(binary.eligible, false);
		assert.equal(binary.reason, 'binary');

		const invalid = evaluate('data.bin', { sample: Buffer.from([0xff, 0xfe, 0xfd]) });
		assert.equal(invalid.reason, 'binary');
	});

	it('rejects known binary extensions even without a content sample', () => {
		for (const relPath of ['photo.png', 'clip.mp4', 'archive.zip', 'font.woff2', 'app.exe']) {
			assert.equal(evaluate(relPath).eligible, false, relPath);
			assert.equal(evaluate(relPath).reason, 'binary', relPath);
		}
	});

	it('explains every skip reason in user-facing words', () => {
		assert.equal(skipExplanation('too-large'), 'Too large to track');
		assert.equal(skipExplanation('binary'), 'Binary or non-UTF-8 content');
		assert.equal(skipExplanation('excluded'), 'Excluded by pattern');
		assert.equal(skipExplanation('symlink'), 'Symbolic link');
		assert.equal(skipExplanation(undefined), 'Not captured');
	});

	it('formats byte sizes readably', () => {
		assert.equal(formatBytes(0), '0 B');
		assert.equal(formatBytes(512), '512 B');
		assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MiB');
		assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GiB');
	});
});
