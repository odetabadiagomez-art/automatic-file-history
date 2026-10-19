import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AutomaticFileHistoryApi } from '../../src/extension';
import type { FileHistory } from '../../src/core/types';

const workspaceRoot = process.env.AFH_INTEGRATION_WORKSPACE ?? '';
const extensionId = process.env.AFH_EXTENSION_ID ?? '';

async function pollFor<T>(
	probe: () => Promise<T | undefined>,
	predicate: (value: T) => boolean,
	timeoutMs = 30_000,
	label = 'condition'
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await probe().catch(() => undefined);
		if (last && predicate(last)) {
			return last;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${last ? ` (last: ${JSON.stringify(last)})` : ''}`);
}

describe('Automatic File History (extension host)', function suite() {
	this.timeout(180_000);

	let api: AutomaticFileHistoryApi;

	before(async () => {
		assert.ok(workspaceRoot, 'the launcher must provide a temporary workspace');
		assert.ok(extensionId, 'the launcher must provide the extension id');

		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension, `extension ${extensionId} should be present in the development host`);
		api = (await extension.activate()) as AutomaticFileHistoryApi;
		assert.ok(api, 'activate() must return the extension API');

		const ready = await api.waitForStartupScan(120_000);
		assert.equal(ready, true, 'the startup baseline scan should complete');
	});

	it('stores history inside the workspace so it travels with the project', async () => {
		const storageRoot = api.storageRoot();
		assert.ok(storageRoot, 'a storage root should exist once monitoring is active');
		assert.equal(
			storageRoot,
			path.join(workspaceRoot, '.file-history'),
			'the default storage location is a .file-history folder inside the workspace'
		);
		const stat = await fs.stat(storageRoot!);
		assert.equal(stat.isDirectory(), true);
	});

	it('never captures its own in-workspace history folder', async () => {
		const history = await api.historyFor(path.join(workspaceRoot, '.file-history', 'files', 'whatever.json'));
		assert.equal(history, null, 'the extension store must not snapshot itself');
	});

	it('reports monitoring rather than claiming protection before the baseline exists', () => {
		const status = api.status();
		assert.ok(status);
		assert.equal(api.isActive(), true);
		assert.ok(
			['monitoring', 'error'].includes(status!.phase),
			`expected monitoring after startup, got "${status!.phase}"`
		);
	});

	it('captures a baseline for a pre-existing eligible file', async () => {
		const history = await api.historyFor(path.join(workspaceRoot, 'seed.md'));
		assert.ok(history, 'seed.md should have history after the startup scan');
		assert.ok(history!.revisions.length >= 1);
		assert.equal(history!.revisions[0].event, 'baseline');
		assert.ok(history!.revisions[0].hash, 'a baseline revision must reference content');
	});

	it('never captures an excluded dependency file', async () => {
		const history = await api.historyFor(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'));
		assert.equal(history, null, 'node_modules content must not be captured');
	});

	it('captures an external write to a file that is not open in any editor', async () => {
		// This is the M0 acceptance proof, run in a real extension host.
		const target = path.join(workspaceRoot, 'external-write.md');
		await fs.writeFile(target, 'first external write\n');

		const first = await pollFor<FileHistory>(
			() => api.historyFor(target) as Promise<FileHistory | null | undefined> as Promise<FileHistory | undefined>,
			history => history !== undefined && history.revisions.length >= 1,
			30_000,
			'the first external write to be captured'
		);
		assert.ok(first.revisions[0].hash);

		await fs.writeFile(target, 'second external write\n');
		const second = await pollFor<FileHistory>(
			() => api.historyFor(target) as Promise<FileHistory | null | undefined> as Promise<FileHistory | undefined>,
			history => history !== undefined && history.revisions.length >= 2,
			30_000,
			'the second external write to be captured'
		);

		assert.equal(second.revisions.length >= 2, true);
		const events = second.revisions.map(revision => revision.event);
		assert.ok(
			events.every(event => event !== 'editor-save'),
			`nothing was saved from an editor, so no entry may claim an editor origin: ${events.join(', ')}`
		);
	});

	it('captures a change to a file that VS Code has open, without duplicating it', async () => {
		const target = path.join(workspaceRoot, 'docs', 'plan.md');
		const uri = vscode.Uri.file(target);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });

		const before = await api.historyFor(target);
		const baselineCount = before?.revisions.length ?? 0;

		const edit = new vscode.WorkspaceEdit();
		edit.insert(uri, new vscode.Position(0, 0), '<!-- edited in the editor -->\n');
		assert.equal(await vscode.workspace.applyEdit(edit), true);
		assert.equal(await document.save(), true);

		const after = await pollFor<FileHistory>(
			() => api.historyFor(target) as Promise<FileHistory | null | undefined> as Promise<FileHistory | undefined>,
			history => history !== undefined && history.revisions.length >= baselineCount + 1,
			30_000,
			'the saved edit to be captured'
		);

		// A save plus its watcher event must collapse into a single revision.
		await new Promise(resolve => setTimeout(resolve, 1_500));
		const settled = await api.historyFor(target);
		assert.equal(
			settled?.revisions.length,
			after.revisions.length,
			'the save and the watcher event must not create two entries'
		);
		assert.ok(settled!.revisions.length >= baselineCount + 1);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	it('records a deletion while keeping the earlier snapshot recoverable', async () => {
		const target = path.join(workspaceRoot, 'to-delete.md');
		await fs.writeFile(target, 'content that will be deleted\n');
		await pollFor<FileHistory>(
			() => api.historyFor(target) as Promise<FileHistory | null | undefined> as Promise<FileHistory | undefined>,
			history => history !== undefined && history.revisions.length >= 1,
			30_000,
			'the new file to be captured'
		);

		await fs.unlink(target);
		const deleted = await pollFor<FileHistory>(
			() => api.historyFor(target) as Promise<FileHistory | null | undefined> as Promise<FileHistory | undefined>,
			history => history !== undefined && history.deleted === true,
			30_000,
			'the deletion to be recorded'
		);

		assert.ok(deleted.revisions.some(revision => revision.event === 'deleted'));
		const contentRevision = [...deleted.revisions].reverse().find(revision => revision.hash);
		assert.ok(contentRevision, 'the pre-delete snapshot must survive');
	});

	it('answers the cooperative checkpoint API with an acknowledgement', async () => {
		const target = path.join(workspaceRoot, 'checkpoint.md');
		await fs.writeFile(target, 'checkpoint content\n');
		const outcome = await api.captureNow(target, 'Integration test checkpoint.');
		assert.ok(['captured', 'unchanged'].includes(outcome.kind), `unexpected outcome: ${outcome.kind}`);
		const history = await api.historyFor(target);
		assert.ok(history && history.revisions.length >= 1);
	});

	it('explains a skip instead of showing an empty view', async () => {
		const description = await api.describeFile(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'));
		assert.equal(description.state, 'skipped');
		assert.equal(description.skipReason, 'excluded');
		assert.match(description.detail, /Excluded by pattern/);
	});

	it('registers its views and commands in the extension host', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of [
			'automaticFileHistory.refresh',
			'automaticFileHistory.compareWithCurrent',
			'automaticFileHistory.restore',
			'automaticFileHistory.exportRevision',
			'automaticFileHistory.showStorageUsage',
			'automaticFileHistory.captureNow',
			'automaticFileHistory.deleteFileHistory',
			'automaticFileHistory.clearWorkspaceHistory',
			'automaticFileHistory.pauseMonitoring',
			'automaticFileHistory.resumeMonitoring',
			'automaticFileHistory.pinFile',
			'automaticFileHistory.showRecentlyChanged'
		]) {
			assert.ok(commands.includes(command), `${command} should be registered`);
		}

		// The tree views must be resolvable, which proves they are contributed.
		await vscode.commands.executeCommand('automaticFileHistory.revisions.focus');
		await vscode.commands.executeCommand('automaticFileHistory.files.focus');
	});

	it('serves snapshot content through the read-only document provider', async () => {
		const target = path.join(workspaceRoot, 'seed.md');
		const history = await api.historyFor(target);
		assert.ok(history && history.revisions.length >= 1);
		const revision = history!.revisions[0];

		const snapshot = vscode.Uri.from({
			scheme: 'afh',
			authority: history!.fileId,
			path: `/${revision.seq}/${path.basename(target)}`
		});
		const document = await vscode.workspace.openTextDocument(snapshot);
		assert.equal(document.getText(), '# seed\n');
	});

	it('pauses and resumes monitoring', async () => {
		await vscode.commands.executeCommand('automaticFileHistory.pauseMonitoring');
		const pausedTarget = path.join(workspaceRoot, 'while-paused.md');
		await fs.writeFile(pausedTarget, 'written while paused\n');
		const outcome = await api.captureNow(pausedTarget);
		assert.equal(outcome.kind, 'skipped', 'nothing may be captured while paused');

		await vscode.commands.executeCommand('automaticFileHistory.resumeMonitoring');
		await api.waitForStartupScan(120_000);
		const resumed = await api.captureNow(pausedTarget);
		assert.ok(['captured', 'unchanged'].includes(resumed.kind), `unexpected outcome after resume: ${resumed.kind}`);
	});
});
