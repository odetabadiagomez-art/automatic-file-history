import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Download a stable VS Code build, open a throwaway workspace, and run the
 * extension-host suite against it. Uses an isolated user-data dir so the real
 * profile and its global storage are never touched.
 */
async function main(): Promise<void> {
	const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
	const extensionTestsPath = path.resolve(__dirname, 'index');

	const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'afh-integration-'));
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afh-profile-'));

	// Seed files that exercise the startup baseline path, including a file that
	// is never opened in an editor and one that must be excluded.
	fs.mkdirSync(path.join(testWorkspace, 'docs'), { recursive: true });
	fs.mkdirSync(path.join(testWorkspace, 'node_modules', 'pkg'), { recursive: true });
	fs.writeFileSync(path.join(testWorkspace, 'seed.md'), '# seed\n');
	fs.writeFileSync(path.join(testWorkspace, 'docs', 'plan.md'), '# plan v1\n');
	fs.writeFileSync(path.join(testWorkspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
	process.env.AFH_INTEGRATION_WORKSPACE = testWorkspace;

	// Derive the id from the manifest so the suite survives a publisher rename.
	const manifest = JSON.parse(
		fs.readFileSync(path.join(extensionDevelopmentPath, 'package.json'), 'utf8')
	) as { publisher: string; name: string };
	const extensionId = `${manifest.publisher}.${manifest.name}`;

	try {
		const failures = await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				testWorkspace,
				`--user-data-dir=${userDataDir}`,
				'--disable-workspace-trust',
				'--disable-gpu',
				'--no-sandbox',
				'--skip-welcome',
				'--skip-release-notes'
			],
			extensionTestsEnv: {
				AFH_INTEGRATION_WORKSPACE: testWorkspace,
				AFH_EXTENSION_ID: extensionId
			}
		});
		if (failures !== 0) {
			throw new Error(`${failures} integration test(s) failed.`);
		}
	} finally {
		fs.rmSync(testWorkspace, { recursive: true, force: true });
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
}

main().catch(err => {
	console.error('Integration run failed:', err);
	process.exit(1);
});
