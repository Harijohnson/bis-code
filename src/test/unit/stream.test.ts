import * as assert from 'assert';
import { parseChatStream, ReasoningDetailsAccumulator, sseData, ToolCallAccumulator } from '../../openrouter/stream';
import { OpenRouterError, type StreamEvent } from '../../openrouter/types';
import { chunked, collect, fixture } from './helpers';

type Done = Extract<StreamEvent, { type: 'done' }>;

suite('SSE reader', () => {
	test('skips comment keep-alives and handles CRLF', async () => {
		const text = ': OPENROUTER PROCESSING\r\n\r\ndata: {"a":1}\r\n\r\n: ping\n\ndata: [DONE]\n\n';
		assert.deepStrictEqual(await collect(sseData(chunked(text, 3))), ['{"a":1}', '[DONE]']);
	});

	test('joins multi-line data fields and flushes a final event without a blank line', async () => {
		const text = 'data: line1\ndata: line2\n\ndata: tail';
		assert.deepStrictEqual(await collect(sseData(chunked(text, 1000))), ['line1\nline2', 'tail']);
	});

	test('handles multi-byte UTF-8 split across chunks', async () => {
		const text = 'data: {"t":"héllo — 世界"}\n\n';
		assert.deepStrictEqual(await collect(sseData(chunked(text, 1))), ['{"t":"héllo — 世界"}']);
	});
});

suite('parseChatStream', () => {
	for (const size of [1, 7, 64, 100_000]) {
		test(`text + reasoning + usage (chunk size ${size})`, async () => {
			const events = await collect(parseChatStream(chunked(fixture('text.sse'), size)));
			const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('');
			const reasoning = events.filter(e => e.type === 'reasoning').map(e => (e as { text: string }).text).join('');
			assert.strictEqual(text, 'Hello, world!');
			assert.strictEqual(reasoning, 'Let me think.');
			const done = events[events.length - 1] as Done;
			assert.strictEqual(done.type, 'done');
			assert.strictEqual(done.finishReason, 'stop');
			assert.strictEqual(done.model, 'anthropic/claude-sonnet-4');
			assert.deepStrictEqual(done.usage, { promptTokens: 1200, completionTokens: 5, totalTokens: 1205, cost: 0.003675 });
			assert.deepStrictEqual(done.toolCalls, []);
		});
	}

	test('accumulates tool-call arguments split across chunks', async () => {
		const events = await collect(parseChatStream(chunked(fixture('toolcalls.sse'), 13)));
		const starts = events.filter(e => e.type === 'toolCallStart');
		assert.deepStrictEqual(starts.map(s => (s as { name: string }).name), ['read_file', 'grep']);
		const done = events[events.length - 1] as Done;
		assert.strictEqual(done.finishReason, 'tool_calls');
		assert.deepStrictEqual(done.toolCalls, [
			{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path": "src/a.ts"}' } },
			{ id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"activate"}' } },
		]);
		assert.deepStrictEqual(JSON.parse(done.toolCalls[0].function.arguments), { path: 'src/a.ts' });
		assert.strictEqual(done.usage?.cost, 0.0021);
	});

	test('an error inside the stream is thrown as OpenRouterError after partial text', async () => {
		const seen: string[] = [];
		await assert.rejects(async () => {
			for await (const ev of parseChatStream(chunked(fixture('error.sse'), 50))) {
				if (ev.type === 'text') {
					seen.push(ev.text);
				}
			}
		}, (err: unknown) => err instanceof OpenRouterError && err.code === 'model' && /Provider disconnected/.test(err.message));
		assert.deepStrictEqual(seen, ['Partial']);
	});

	test('stops at [DONE] and ignores anything after it', async () => {
		const text = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n';
		const events = await collect(parseChatStream(chunked(text, 1000)));
		assert.deepStrictEqual(events.filter(e => e.type === 'text').map(e => (e as { text: string }).text), ['a']);
	});

	test('in-stream 401/402 errors map to auth/credits', async () => {
		const auth = 'data: {"error":{"code":401,"message":"No auth"}}\n\n';
		await assert.rejects(collect(parseChatStream(chunked(auth, 100))), (e: unknown) => e instanceof OpenRouterError && e.code === 'auth');
		const credits = 'data: {"error":{"code":402,"message":"Insufficient credits"}}\n\n';
		await assert.rejects(collect(parseChatStream(chunked(credits, 100))), (e: unknown) => e instanceof OpenRouterError && e.code === 'credits');
	});
});

suite('ToolCallAccumulator', () => {
	test('missing arguments become {}', () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, id: 'c1', function: { name: 'list_dir' } }]);
		assert.strictEqual(acc.finish()[0].function.arguments, '{}');
	});

	test('a new id on a reused index starts a new call', () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }]);
		const started = acc.add([{ index: 0, id: 'c2', function: { name: 'read_file', arguments: '{"path":"b"}' } }]);
		assert.strictEqual(started.length, 1);
		const calls = acc.finish();
		assert.deepStrictEqual(calls.map(c => [c.id, c.function.arguments]), [['c1', '{"path":"a"}'], ['c2', '{"path":"b"}']]);
	});

	test('deltas without an index continue the last call', () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ id: 'c1', function: { name: 'grep', arguments: '{"pat' } }]);
		acc.add([{ function: { arguments: 'tern":"x"}' } }]);
		assert.strictEqual(acc.finish()[0].function.arguments, '{"pattern":"x"}');
	});

	test('generates an id when the provider sends none', () => {
		const acc = new ToolCallAccumulator();
		acc.add([{ index: 0, function: { name: 'glob', arguments: '{}' } }]);
		assert.ok(acc.finish()[0].id.startsWith('call_'));
	});
});

suite('ReasoningDetailsAccumulator', () => {
	test('concatenates text by index and keeps the latest signature', () => {
		const acc = new ReasoningDetailsAccumulator();
		acc.add([{ type: 'reasoning.text', text: 'Hel', index: 0 }]);
		acc.add([{ type: 'reasoning.text', text: 'lo', index: 0, signature: 'sig' }]);
		assert.deepStrictEqual(acc.finish(), [{ type: 'reasoning.text', text: 'Hello', index: 0, signature: 'sig' }]);
	});
});
