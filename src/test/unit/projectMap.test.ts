import * as assert from 'assert';
import { renderProjectMap, type MapData, type MapRoot } from '../../util/projectTree';

const GENERATED = Date.UTC(2026, 0, 2, 3, 4);

function data(roots: MapRoot[], gitignore = true): MapData {
	return { generatedAt: GENERATED, gitignore, roots };
}

const FILES = [
	'package.json',
	'README.md',
	'src/extension.ts',
	'src/agent/agentLoop.ts',
	'src/agent/context.ts',
	'src/tools/grep.ts',
	'src/tools/deep/nested/a.ts',
	'webview-ui/src/App.tsx',
];

suite('project map', () => {
	test('groups files by directory, parents before children, with stats and key files', () => {
		const text = renderProjectMap(data([{ name: 'app', prefix: '', files: FILES }]), 10_000);
		const lines = text.split('\n');
		assert.match(text, /^Generated 2026-01-02 03:04 UTC\. /);
		assert.match(text, /skips \.gitignore'd files/);
		assert.ok(lines.includes('## app'));
		assert.ok(lines.includes('8 files (.ts 5, .json 1, .md 1, .tsx 1)'));
		assert.ok(lines.includes('Key files: README.md, package.json'));

		const tree = lines.slice(lines.indexOf('Structure (directory: files):') + 1);
		assert.deepStrictEqual(tree, [
			'./: README.md, package.json',
			'src/: extension.ts',
			'src/agent/: agentLoop.ts, context.ts',
			'src/tools/: grep.ts',
			'src/tools/deep/nested/: a.ts',
			'webview-ui/src/: App.tsx',
		]);
	});

	test('collapses deep directories into their ancestor when over budget', () => {
		const many = Array.from({ length: 60 }, (_, i) => `lib/vendor/pkg${i}/index.js`);
		const full = renderProjectMap(data([{ name: 'app', prefix: '', files: [...FILES, ...many] }]), 100_000);
		const small = renderProjectMap(data([{ name: 'app', prefix: '', files: [...FILES, ...many] }]), 1_500);
		assert.ok(full.includes('lib/vendor/pkg7/: index.js'));
		assert.ok(small.length <= 1_500, `rendered ${small.length} chars`);
		assert.ok(!small.includes('pkg7/: index.js'));
		assert.ok(small.includes('lib/vendor/: [+60 files in pkg0/, pkg1/, pkg10/'), small);
		assert.ok(small.includes('… (+48 more)]'));
		assert.ok(small.includes('src/tools/: grep.ts [+1 file in deep/]'));
	});

	test('hard-truncates when even the top level does not fit', () => {
		const wide = Array.from({ length: 200 }, (_, i) => `file-with-a-fairly-long-name-${i}.txt`);
		const text = renderProjectMap(data([{ name: 'app', prefix: '', files: wide }]), 900);
		assert.ok(text.length <= 900, `rendered ${text.length} chars`);
		assert.match(text, /map truncated/);
	});

	test('summarizes package.json and prefixes paths in multi-root workspaces', () => {
		const pkg = JSON.stringify({
			name: 'web', version: '1.2.3',
			scripts: { build: 'x', test: 'y' },
			dependencies: { react: '^19' },
			devDependencies: { typescript: '^6' },
		});
		const text = renderProjectMap(data([
			{ name: 'web', prefix: 'web/', files: ['package.json', 'src/index.ts'], packageJson: pkg },
			{ name: 'api', prefix: 'api/', files: ['main.go', 'go.mod'], truncated: true },
		], false), 10_000);
		assert.ok(text.includes('package.json: web@1.2.3 · scripts: build, test · dependencies: react · devDependencies: typescript'));
		assert.ok(text.includes('web/src/: index.ts'));
		assert.ok(text.includes('api/: go.mod, main.go'));
		assert.ok(text.includes('2+ files'), 'truncated listings are marked');
		assert.ok(!text.includes(".gitignore'd"), 'only claims gitignore when it was used');
	});

	test('ignores an invalid package.json and handles an empty folder', () => {
		const text = renderProjectMap(data([
			{ name: 'a', prefix: 'a/', files: ['package.json'], packageJson: '{ not json' },
			{ name: 'b', prefix: 'b/', files: [] },
		]), 10_000);
		assert.ok(!text.includes('package.json:'));
		assert.ok(text.includes('## b\nNo files found.'));
	});
});
