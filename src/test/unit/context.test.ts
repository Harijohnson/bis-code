import * as assert from 'assert';
import { compactMessages, contextBudget, effectiveMaxTokens, estimateTokens, findCompactionSplit } from '../../agent/context';
import type { ChatMessage, ChatRequest } from '../../openrouter/types';
import type { ModelInfo } from '../../shared/protocol';
import { diffPreview } from '../../util/lineDiff';
import { truncateMiddle } from '../../util/text';

function model(contextLength: number, maxCompletionTokens?: number): ModelInfo {
	return {
		id: 'x/y', name: 'X', description: '', provider: 'x', contextLength, promptPrice: 0, completionPrice: 0,
		inputModalities: ['text'], supportedParameters: ['tools'], maxCompletionTokens,
		supportsTools: true, supportsVision: false, supportsReasoning: false, isFree: false,
	};
}

const big = (n: number) => 'x'.repeat(n);

/** user → assistant(tool) → tool → assistant, repeated. */
function conversation(turns: number, size: number): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let t = 0; t < turns; t++) {
		out.push({ role: 'user', content: `turn ${t} ${big(size)}` });
		out.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${t}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
		out.push({ role: 'tool', tool_call_id: `c${t}`, content: big(size) });
		out.push({ role: 'assistant', content: `answer ${t}` });
	}
	return out;
}

function isValidHistory(messages: ChatMessage[]): boolean {
	const pending = new Set<string>();
	for (const m of messages) {
		if (m.role === 'assistant' && m.tool_calls) {
			if (pending.size) {
				return false;
			}
			m.tool_calls.forEach(c => pending.add(c.id));
		} else if (m.role === 'tool') {
			if (!pending.delete(m.tool_call_id)) {
				return false;
			}
		} else if (pending.size) {
			return false;
		}
	}
	return pending.size === 0;
}

suite('context budgeting', () => {
	test('truncateMiddle keeps head and tail', () => {
		const s = 'a'.repeat(50) + 'b'.repeat(50);
		const t = truncateMiddle(s, 20);
		assert.ok(t.startsWith('a'.repeat(10)) && t.endsWith('b'.repeat(10)));
		assert.match(t, /truncated 80 chars/);
		assert.strictEqual(truncateMiddle('short', 20), 'short');
	});

	test('max_tokens is capped by the model', () => {
		assert.strictEqual(effectiveMaxTokens(model(200000, 64000), 8192), 8192);
		assert.strictEqual(effectiveMaxTokens(model(200000, 4096), 8192), 4096);
		assert.strictEqual(effectiveMaxTokens(model(8000), 8192), 4000);
		assert.strictEqual(effectiveMaxTokens(undefined, 8192), 8192);
	});

	test('budget = context − output − margin', () => {
		assert.strictEqual(contextBudget(model(200000), 8192), 200000 - 8192 - 10000);
		assert.ok(contextBudget(undefined, 8192) > 0);
	});

	test('token estimate uses chars/3.5 by default', () => {
		assert.strictEqual(estimateTokens(350), 100);
		assert.strictEqual(estimateTokens(350, 7), 50);
	});
});

suite('compaction', () => {
	test('the split never separates a tool call from its result', () => {
		const messages = conversation(6, 200);
		for (const budget of [100, 500, 1000, 3000, 10000]) {
			const split = findCompactionSplit(messages, budget);
			if (split === undefined) {
				continue;
			}
			assert.notStrictEqual(messages[split].role, 'tool');
			const prev = messages[split - 1];
			assert.ok(!(prev.role === 'assistant' && prev.tool_calls?.length), `budget ${budget}`);
			assert.ok(isValidHistory(messages.slice(split)));
		}
	});

	test('nothing to compact in a tiny conversation', () => {
		assert.strictEqual(findCompactionSplit([{ role: 'user', content: 'hi' }], 10), undefined);
	});

	test('replaces old messages with a summary and keeps a valid tail', async () => {
		const session = { messages: conversation(8, 4000) };
		const requests: ChatRequest[] = [];
		const client = {
			async chat(req: ChatRequest) {
				requests.push(req);
				return { content: 'SUMMARY: user wants X; files a.ts', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 } };
			},
		};
		const before = session.messages.length;
		const result = await compactMessages(session, client, 'x/y', 20_000);
		assert.ok(result && result.compacted > 0);
		assert.ok(session.messages.length < before);
		assert.strictEqual(session.messages[0].role, 'user');
		assert.match(session.messages[0].content as string, /SUMMARY: user wants X/);
		assert.ok(isValidHistory(session.messages));
		for (let i = 1; i < session.messages.length; i++) {
			assert.ok(!(session.messages[i].role === 'user' && session.messages[i - 1].role === 'user'), 'no back-to-back user messages');
		}
		assert.strictEqual(requests.length, 1);
		assert.match(requests[0].messages[1].content as string, /turn 0/);
		assert.strictEqual(result!.usage?.cost, 0.001);
	});
});

suite('diff preview', () => {
	test('counts added and removed lines with context', () => {
		const before = 'a\nb\nc\nd\ne\nf\ng\n';
		const after = 'a\nb\nC\nd\ne\nf\ng\nh\n';
		const p = diffPreview(before, after, 60, 1);
		assert.strictEqual(p.added, 2);
		assert.strictEqual(p.removed, 1);
		assert.match(p.text, /- c\n\+ C/);
		assert.match(p.text, /\+ h/);
		assert.match(p.text, /⋯/);
	});

	test('new file is all additions', () => {
		const p = diffPreview('', 'x\ny\n');
		assert.strictEqual(p.added, 2);
		assert.strictEqual(p.removed, 0);
	});
});
