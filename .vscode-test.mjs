import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Integration tests edit files, so they get a fresh temporary workspace.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-code-test-'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: workspace,
	launchArgs: ['--disable-workspace-trust', '--disable-extensions'],
	mocha: {
		ui: 'tdd',
		timeout: 30000,
	},
});
