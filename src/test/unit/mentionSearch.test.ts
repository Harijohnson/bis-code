import * as assert from 'assert';
import { activeMentions, baseName, findMentionQuery, fuzzyMatch, searchMentions, splitMentions } from '../../shared/mentionSearch';
import type { MentionItem } from '../../shared/protocol';

const items: MentionItem[] = [
	{ path: 'src/', kind: 'folder' },
	{ path: 'src/agent/', kind: 'folder' },
	{ path: 'src/agent/controller.ts', kind: 'file' },
	{ path: 'src/agent/context.ts', kind: 'file' },
	{ path: 'src/webview/ChatViewProvider.ts', kind: 'file' },
	{ path: 'README.md', kind: 'file' },
	{ path: 'package.json', kind: 'file' },
];

suite('mention search', () => {
	test('baseName handles files and folders', () => {
		assert.strictEqual(baseName('src/agent/controller.ts'), 'controller.ts');
		assert.strictEqual(baseName('src/agent/'), 'agent');
		assert.strictEqual(baseName('README.md'), 'README.md');
	});

	test('fuzzyMatch prefers file-name hits and rejects non-matches', () => {
		const name = fuzzyMatch('contr', 'src/agent/controller.ts')!;
		const path = fuzzyMatch('agent', 'src/agent/controller.ts')!;
		assert.ok(name.score > path.score);
		assert.deepStrictEqual(name.positions, [10, 11, 12, 13, 14]);
		assert.strictEqual(fuzzyMatch('xyz', 'src/agent/controller.ts'), undefined);
		assert.ok(fuzzyMatch('cvp', 'src/webview/ChatViewProvider.ts'), 'camel-case subsequence');
	});

	test('searchMentions ranks the best match first', () => {
		assert.strictEqual(searchMentions(items, 'contr', 10)[0].path, 'src/agent/controller.ts');
		assert.strictEqual(searchMentions(items, 'readme', 10)[0].path, 'README.md');
		assert.deepStrictEqual(searchMentions(items, 'zzz', 10), []);
	});

	test('empty query lists open editors first, then shallow entries', () => {
		const out = searchMentions(items, '', 3, ['src/agent/context.ts']);
		assert.strictEqual(out[0].path, 'src/agent/context.ts');
		assert.strictEqual(out[1].path, 'src/', 'top-level folder before top-level files');
		assert.strictEqual(out.length, 3);
	});

	test('findMentionQuery finds the @token at the caret', () => {
		assert.deepStrictEqual(findMentionQuery('look at @src/ag', 15), { start: 8, query: 'src/ag' });
		assert.deepStrictEqual(findMentionQuery('@', 1), { start: 0, query: '' });
		assert.strictEqual(findMentionQuery('mail me@example.com', 19), undefined, 'needs whitespace before @');
		assert.strictEqual(findMentionQuery('@src/a.ts done', 14), undefined, 'caret past the token');
	});

	test('activeMentions keeps only mentions still in the text, in order', () => {
		const text = 'compare @src/agent/context.ts with @README.md.';
		assert.deepStrictEqual(activeMentions(text, ['README.md', 'package.json', 'src/agent/context.ts']), ['src/agent/context.ts', 'README.md']);
		assert.deepStrictEqual(activeMentions('see @src/agent/context.tsx', ['src/agent/context.ts']), [], 'must end at a boundary');
	});

	test('splitMentions prefers the longest mention', () => {
		const segs = splitMentions('in @src/agent/ and @src/agent/controller.ts', ['src/agent/', 'src/agent/controller.ts']);
		assert.deepStrictEqual(segs, [
			{ text: 'in ' },
			{ text: '@src/agent/', mention: 'src/agent/' },
			{ text: ' and ' },
			{ text: '@src/agent/controller.ts', mention: 'src/agent/controller.ts' },
		]);
	});
});
