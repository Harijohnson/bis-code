import * as assert from 'assert';
import type { TranscriptEvent, TranscriptItem } from '../../shared/protocol';
import { applyTranscriptEvent, settleTranscript } from '../../shared/transcript';

function run(events: TranscriptEvent[], start: TranscriptItem[] = []): TranscriptItem[] {
	return events.reduce(applyTranscriptEvent, start);
}

suite('transcript reducer', () => {
	test('builds an assistant message with streamed text and a tool call lifecycle', () => {
		const items = run([
			{ type: 'transcriptAppend', item: { kind: 'user', id: 'u1', text: 'hi' } },
			{ type: 'assistantStart', messageId: 'm1', model: 'x/y' },
			{ type: 'reasoningDelta', messageId: 'm1', text: 'hmm' },
			{ type: 'textDelta', messageId: 'm1', text: 'Hel' },
			{ type: 'textDelta', messageId: 'm1', text: 'lo' },
			{ type: 'toolCall', messageId: 'm1', callId: 'c1', name: 'edit_file', args: { path: 'a' }, status: 'pending' },
			{ type: 'approvalRequest', callId: 'c1', kind: 'edit', preview: 'Edit a\n+ x' },
		]);
		const a = items[1];
		assert.ok(a.kind === 'assistant');
		assert.strictEqual(a.text, 'Hello');
		assert.strictEqual(a.reasoning, 'hmm');
		assert.strictEqual(a.toolCalls[0].status, 'awaitingApproval');
		assert.strictEqual(a.toolCalls[0].approval?.kind, 'edit');

		const after = run([
			{ type: 'toolCall', messageId: 'm1', callId: 'c1', name: 'edit_file', args: { path: 'a' }, status: 'running' },
			{ type: 'toolOutput', callId: 'c1', chunk: 'out' },
			{ type: 'toolResult', callId: 'c1', ok: true, summary: 'Edited a' },
			{ type: 'turnDone', id: 'f1', model: 'x/y', cost: 0.01 },
		], items);
		const call = (after[1] as Extract<TranscriptItem, { kind: 'assistant' }>).toolCalls[0];
		assert.strictEqual(call.status, 'done');
		assert.strictEqual(call.approval, undefined, 'approval cleared once running');
		assert.strictEqual(call.output, 'out');
		assert.strictEqual(call.summary, 'Edited a');
		assert.strictEqual(after[2].kind, 'footer');
	});

	test('sub-agent messages carry their agent tag; main-agent messages have none', () => {
		const tag = { id: 'agent_1', kind: 'explore' as const, label: 'Find the auth flow' };
		const items = run([
			{ type: 'assistantStart', messageId: 'm1', model: 'x' },
			{ type: 'assistantStart', messageId: 'm2', model: 'x', agent: tag },
			{ type: 'textDelta', messageId: 'm2', text: 'report' },
		]);
		assert.ok(items[0].kind === 'assistant' && !('agent' in items[0]));
		assert.ok(items[1].kind === 'assistant');
		assert.deepStrictEqual(items[1].agent, tag);
		assert.strictEqual(items[1].text, 'report');
	});

	test('does not mutate the previous array', () => {
		const start: TranscriptItem[] = [{ kind: 'assistant', id: 'm', model: 'x', text: 'a', reasoning: '', toolCalls: [] }];
		const next = applyTranscriptEvent(start, { type: 'textDelta', messageId: 'm', text: 'b' });
		assert.strictEqual((start[0] as { text: string }).text, 'a');
		assert.strictEqual((next[0] as { text: string }).text, 'ab');
	});

	test('transcriptRemove and error items', () => {
		const items = run([
			{ type: 'transcriptAppend', item: { kind: 'user', id: 'u1', text: 'hi' } },
			{ type: 'error', id: 'e1', code: 'auth', message: 'bad key', retryable: false },
			{ type: 'transcriptRemove', id: 'u1' },
		]);
		assert.deepStrictEqual(items.map(i => i.kind), ['error']);
	});

	test('settleTranscript marks unfinished tool calls as interrupted', () => {
		const items = run([
			{ type: 'assistantStart', messageId: 'm1', model: 'x' },
			{ type: 'toolCall', messageId: 'm1', callId: 'c1', name: 'run_command', args: {}, status: 'running' },
		]);
		const settled = settleTranscript(items);
		const call = (settled[0] as Extract<TranscriptItem, { kind: 'assistant' }>).toolCalls[0];
		assert.strictEqual(call.status, 'error');
		assert.strictEqual(call.summary, 'Interrupted');
		assert.strictEqual(settleTranscript(settled), settled, 'no-op when already settled');
	});
});
