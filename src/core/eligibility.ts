import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { canonicalPathForIdentity, toPosixPath } from './ids';
import type { CapturePolicy, Eligibility, SkipReason } from './types';

/**
 * Default exclusions. Three families, all documented in the README:
 *  - version-control and dependency trees (huge, churny, recoverable elsewhere)
 *  - build output and caches (regenerable, high write rate)
 *  - likely secrets (capturing these would copy credentials into local history)
 */
export const DEFAULT_EXCLUDES: string[] = [
	// Version control
	'**/.git/**',
	'**/.svn/**',
	'**/.hg/**',
	// Dependencies
	'**/node_modules/**',
	'**/bower_components/**',
	'**/vendor/**',
	'**/Pods/**',
	'**/.venv/**',
	'**/venv/**',
	'**/env/**',
	'**/.tox/**',
	'**/.nox/**',
	'**/site-packages/**',
	// Caches
	'**/__pycache__/**',
	'**/.mypy_cache/**',
	'**/.pytest_cache/**',
	'**/.ruff_cache/**',
	'**/.cache/**',
	'**/.gradle/**',
	'**/.idea/**',
	// Build output
	'**/dist/**',
	'**/build/**',
	'**/out/**',
	'**/target/**',
	'**/coverage/**',
	'**/.next/**',
	'**/.nuxt/**',
	'**/.output/**',
	'**/.turbo/**',
	'**/bin/**',
	'**/obj/**',
	// Minified / generated / noisy
	'**/*.min.js',
	'**/*.min.css',
	'**/*.map',
	'**/*.lock',
	'**/package-lock.json',
	'**/yarn.lock',
	'**/pnpm-lock.yaml',
	'**/*.log',
	'**/.DS_Store',
	// Likely secrets
	'**/.env',
	'**/.env.*',
	'**/*.pem',
	'**/*.key',
	'**/*.p12',
	'**/*.pfx',
	'**/*.keystore',
	'**/*.jks',
	'**/id_rsa',
	'**/id_dsa',
	'**/id_ecdsa',
	'**/id_ed25519',
	'**/secrets.json',
	'**/secrets.yml',
	'**/secrets.yaml',
	'**/credentials',
	'**/credentials.json',
	'**/*secret*',
	'**/*token*.json'
];

/** Extensions that are never treated as text, even if they sniff clean. */
const BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tiff',
	'psd', 'ai', 'sketch', 'fig',
	'mp3', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'mid',
	'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv',
	'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst', 'br',
	'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
	'otf', 'ttf', 'woff', 'woff2', 'eot',
	'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'obj', 'class', 'jar',
	'war', 'pyc', 'pyd', 'pyo', 'pyz', 'whl', 'egg',
	'node', 'wasm', 'db', 'sqlite', 'sqlite3', 'mdb',
	'mp4v', 'heic', 'heif', 'raw', 'dng', 'cr2', 'nef', 'arw',
	'blend', 'fbx', 'glb', 'gltf', 'obj3d', 'stl', 'usdz',
	'dmg', 'iso', 'img', 'pkg', 'deb', 'rpm', 'apk', 'ipa',
	'keystore', 'jks', 'p12', 'pfx', 'cer', 'der'
]);

const MATCH_OPTIONS = { dot: true, nocase: process.platform === 'win32' };

/** Effective exclude list: user patterns first, then the defaults. */
export function effectiveExcludes(policy: CapturePolicy): string[] {
	return [...policy.excludeGlobs, ...DEFAULT_EXCLUDES];
}

function matchAny(relPosix: string, patterns: string[]): string | undefined {
	const base = path.posix.basename(relPosix);
	for (const pattern of patterns) {
		if (!pattern) {
			continue;
		}
		if (minimatch(relPosix, pattern, MATCH_OPTIONS) || minimatch(base, pattern, MATCH_OPTIONS)) {
			return pattern;
		}
	}
	return undefined;
}

/**
 * Exclusion check for a file. User excludes win over user includes, which win
 * over the defaults, so a user can both hide extra paths and rescue a path that
 * a default would otherwise hide.
 */
export function findExclusion(
	relPath: string,
	policy: CapturePolicy
): { excluded: boolean; pattern?: string; source?: 'user-exclude' | 'user-include' | 'default' } {
	const rel = toPosixPath(relPath);
	const userExclude = matchAny(rel, policy.excludeGlobs);
	if (userExclude) {
		return { excluded: true, pattern: userExclude, source: 'user-exclude' };
	}
	const userInclude = matchAny(rel, policy.includeGlobs);
	if (userInclude) {
		return { excluded: false, pattern: userInclude, source: 'user-include' };
	}
	const def = matchAny(rel, DEFAULT_EXCLUDES);
	if (def) {
		return { excluded: true, pattern: def, source: 'default' };
	}
	return { excluded: false };
}

/**
 * Directory-level exclusion used to prune the startup walk. A directory is
 * excluded when a synthetic child inside it would be excluded, which keeps
 * `**\/node_modules/**` style patterns working without a second rule set.
 */
export function isExcludedDirectory(relDirPath: string, policy: CapturePolicy): boolean {
	const probe = path.posix.join(toPosixPath(relDirPath), '__afh_probe__');
	return findExclusion(probe, policy).excluded;
}

/**
 * Cheap content sniff. A NUL byte in the sampled prefix means binary; invalid
 * UTF-8 is reported separately so the caller can explain the skip accurately.
 */
export function classifyContent(sample: Buffer): 'text' | 'binary' {
	const limit = Math.min(sample.length, 8192);
	for (let i = 0; i < limit; i++) {
		if (sample[i] === 0) {
			return 'binary';
		}
	}
	return 'text';
}

/** True when the buffer cannot be decoded as UTF-8 without replacement chars. */
export function isLikelyValidUtf8(buf: Buffer): boolean {
	try {
		const decoded = new TextDecoder('utf-8', { fatal: true });
		decoded.decode(buf.subarray(0, Math.min(buf.length, 64 * 1024)));
		return true;
	} catch {
		return false;
	}
}

export interface EvaluateInput {
	/** Absolute path on disk. */
	absPath: string;
	/** Path relative to the workspace folder (display + glob matching). */
	relPath: string;
	size: number;
	isSymbolicLink: boolean;
	isDirectory: boolean;
	/** Extension-managed storage root; anything inside it is never captured. */
	storageRoot?: string;
	/** Sampled leading bytes, when already available. */
	sample?: Buffer;
	policy: CapturePolicy;
}

/**
 * Decide whether a file is eligible for capture, with an explanation that the
 * UI can show verbatim. Never throws.
 */
export function evaluateEligibility(input: EvaluateInput): Eligibility {
	if (input.storageRoot) {
		const storage = canonicalPathForIdentity(input.storageRoot);
		const candidate = canonicalPathForIdentity(input.absPath);
		if (candidate === storage || candidate.startsWith(storage + path.sep)) {
			return refuse('extension-storage', 'Extension history storage is never captured.');
		}
	}
	if (input.isDirectory) {
		return refuse('not-a-file', 'Directories are not versioned.');
	}
	if (input.isSymbolicLink) {
		return refuse('symlink', 'Symbolic links are skipped in this release.');
	}
	if (input.size > input.policy.maxFileBytes) {
		return refuse(
			'too-large',
			`Larger than the ${formatBytes(input.policy.maxFileBytes)} tracking limit.`
		);
	}
	const exclusion = findExclusion(input.relPath, input.policy);
	if (exclusion.excluded) {
		return refuse(
			'excluded',
			`Excluded by pattern "${exclusion.pattern}"${exclusion.source === 'user-exclude' ? ' (your settings)' : ''}.`
		);
	}
	const ext = path.extname(input.relPath).slice(1).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) {
		return refuse('binary', `".${ext}" files are not versioned in this release.`);
	}
	if (input.sample) {
		if (classifyContent(input.sample) === 'binary') {
			return refuse('binary', 'Content contains NUL bytes, so it is treated as binary.');
		}
		if (!isLikelyValidUtf8(input.sample)) {
			return refuse('binary', 'Content is not valid UTF-8, so it is treated as binary.');
		}
	}
	return { eligible: true };
}

function refuse(reason: SkipReason, detail: string): Eligibility {
	return { eligible: false, reason, detail };
}

/** Reason text for a file that could not be captured. */
export function skipExplanation(reason: SkipReason | undefined): string {
	switch (reason) {
		case 'too-large':
			return 'Too large to track';
		case 'binary':
			return 'Binary or non-UTF-8 content';
		case 'excluded':
			return 'Excluded by pattern';
		case 'symlink':
			return 'Symbolic link';
		case 'not-a-file':
			return 'Not a regular file';
		case 'extension-storage':
			return 'Extension storage';
		case 'missing':
			return 'File no longer exists';
		default:
			return 'Not captured';
	}
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
