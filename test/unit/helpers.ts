import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureEngine } from '../../src/core/captureEngine';
import { HistoryStore } from '../../src/core/store';
import { DEFAULT_POLICY, type CapturePolicy, type CaptureOutcome, type CaptureRequest } from '../../src/core/types';

export interface TestWorkspace {
	/** Temporary "project" folder that stands in for a workspace folder. */
	root: string;
	/** Temporary extension-managed storage folder. */
	storageRoot: string;
	store: HistoryStore;
	engine: CaptureEngine;
	policy: CapturePolicy;
}

const tempRoots: string[] = [];

export async function tempDir(prefix = 'afh-'): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

/** Remove every temporary folder this process created. */
export async function cleanupTempDirs(): Promise<void> {
	for (const dir of tempRoots.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function removeDir(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Write a file inside the fake workspace, creating parent folders. */
export async function writeProjectFile(
	root: string,
	relPath: string,
	content: string | Buffer
): Promise<string> {
	const abs = path.join(root, relPath);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
	return abs;
}

export function testPolicy(overrides: Partial<CapturePolicy> = {}): CapturePolicy {
	return {
		...DEFAULT_POLICY,
		// Keep unit tests fast; the timing-sensitive paths are exercised separately.
		stabilizationDelayMs: 0,
		stabilizationAttempts: 2,
		readRetries: 1,
		...overrides
	};
}

/** A store plus engine wired to a throwaway workspace and storage folder. */
export async function createWorkspace(
	policyOverrides: Partial<CapturePolicy> = {}
): Promise<TestWorkspace> {
	const root = await tempDir('afh-workspace-');
	const storageRoot = await tempDir('afh-storage-');
	const policy = testPolicy(policyOverrides);

	const store = await HistoryStore.open({
		rootDir: path.join(storageRoot, 'ws-test'),
		workspaceId: 'test-workspace',
		policy
	});
	const engine = new CaptureEngine({ store, storageRoot: store.rootDir, policy });

	return { root, storageRoot, store, engine, policy };
}

export function captureRequest(
	workspace: TestWorkspace,
	relPath: string,
	overrides: Partial<CaptureRequest> = {}
): CaptureRequest {
	return {
		path: path.join(workspace.root, relPath),
		relPath,
		rootName: 'test-workspace',
		event: 'disk-change',
		origin: 'unknown',
		...overrides
	};
}

/** Capture the current on-disk state of a workspace file. */
export async function captureFile(
	workspace: TestWorkspace,
	relPath: string,
	overrides: Partial<CaptureRequest> = {}
): Promise<CaptureOutcome> {
	return workspace.engine.capture(captureRequest(workspace, relPath, overrides));
}

export async function readHistory(workspace: TestWorkspace, relPath: string) {
	return workspace.store.getHistoryByPath(path.join(workspace.root, relPath));
}
