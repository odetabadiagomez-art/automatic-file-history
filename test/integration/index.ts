import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

/** Entry point used by `--extensionTestsPath`; runs inside the extension host. */
export function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 120_000 });
	const testsRoot = __dirname;

	return new Promise((resolve, reject) => {
		let files: string[];
		try {
			files = fs.readdirSync(testsRoot).filter(name => name.endsWith('.test.js'));
		} catch (err) {
			reject(err);
			return;
		}
		for (const file of files) {
			mocha.addFile(path.join(testsRoot, file));
		}
		try {
			mocha.run(failures => {
				if (failures > 0) {
					reject(new Error(`${failures} integration test(s) failed.`));
				} else {
					resolve();
				}
			});
		} catch (err) {
			reject(err);
		}
	});
}
