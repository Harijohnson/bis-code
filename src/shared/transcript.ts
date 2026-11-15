import type { ToolCallView, TranscriptEvent, TranscriptItem } from './protocol';

/** Max characters of streamed command output kept in the transcript (tail wins). */
export const MAX_TRANSCRIPT_OUTPUT = 30_000;

type AssistantItem = Extract<TranscriptItem, { kind: 'assistant' }>;

function replaceAt(items: TranscriptItem[], index: number, item: TranscriptItem): TranscriptItem[] {
	const copy = items.slice();
	copy[index] = item;
	return copy;
}

function updateAssistant(items: TranscriptItem[], messageId: string, fn: (item: AssistantItem) => AssistantItem): TranscriptItem[] {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'assistant' && item.id === messageId) {
			return replaceAt(items, i, fn(item));
		}
	}
	return items;
}

function updateToolCall(items: TranscriptItem[], callId: string, fn: (call: ToolCallView) => ToolCallView): TranscriptItem[] {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind !== 'assistant') {
			continue;
		}
		const idx = item.toolCalls.findIndex(c => c.callId === callId);
		if (idx >= 0) {
			const toolCalls = item.toolCalls.slice();
			toolCalls[idx] = fn(toolCalls[idx]);
			return replaceAt(items, i, { ...item, toolCalls });
		}
	}
	return items;
}

/**
 * Pure reducer used by both the extension (to keep the persisted transcript) and the
 * webview (to render it). Returns a new array when anything changed.
 */
export function applyTranscriptEvent(items: TranscriptItem[], ev: TranscriptEvent): TranscriptItem[] {
	switch (ev.type) {
		case 'transcriptAppend':
			return [...items, ev.item];

		case 'transcriptRemove':
			return items.filter(i => i.id !== ev.id);

		case 'assistantStart':
			return [...items, { kind: 'assistant', id: ev.messageId, model: ev.model, text: '', reasoning: '', toolCalls: [] }];

		case 'textDelta':
			return updateAssistant(items, ev.messageId, a => ({ ...a, text: a.text + ev.text }));

		case 'reasoningDelta':
			return updateAssistant(items, ev.messageId, a => ({ ...a, reasoning: a.reasoning + ev.text }));

		case 'toolCall':
			return updateAssistant(items, ev.messageId, a => {
				const idx = a.toolCalls.findIndex(c => c.callId === ev.callId);
				const base: ToolCallView = idx >= 0 ? a.toolCalls[idx] : { callId: ev.callId, name: ev.name, args: ev.args, status: ev.status };
				const next: ToolCallView = {
					...base,
					name: ev.name,
					args: ev.args,
					status: ev.status,
					approval: ev.status === 'awaitingApproval' ? base.approval : undefined,
				};
				const toolCalls = a.toolCalls.slice();
				if (idx >= 0) {
					toolCalls[idx] = next;
				} else {
					toolCalls.push(next);
				}
				return { ...a, toolCalls };
			});

		case 'toolOutput':
			return updateToolCall(items, ev.callId, c => {
				let output = (c.output ?? '') + ev.chunk;
				if (output.length > MAX_TRANSCRIPT_OUTPUT) {
					output = '…' + output.slice(output.length - MAX_TRANSCRIPT_OUTPUT);
				}
				return { ...c, output };
			});

		case 'toolResult':
			return updateToolCall(items, ev.callId, c => ({
				...c,
				status: ev.status ?? (ev.ok ? 'done' : 'error'),
				summary: ev.summary,
				detail: ev.detail,
				approval: undefined,
			}));

		case 'approvalRequest':
			return updateToolCall(items, ev.callId, c => ({
				...c,
				status: 'awaitingApproval',
				approval: { kind: ev.kind, preview: ev.preview, allowPrefix: ev.allowPrefix },
			}));

		case 'turnDone':
			return [...items, { kind: 'footer', id: ev.id, model: ev.model, usage: ev.usage, cost: ev.cost, stopped: ev.stopped }];

		case 'error':
			return [...items, { kind: 'error', id: ev.id, code: ev.code, message: ev.message, retryable: ev.retryable }];
	}
}

/** Marks every unfinished tool call as stopped. Used when a session is loaded after a crash or reload. */
export function settleTranscript(items: TranscriptItem[]): TranscriptItem[] {
	let changed = false;
	const next = items.map(item => {
		if (item.kind !== 'assistant' || !item.toolCalls.some(c => c.status === 'pending' || c.status === 'running' || c.status === 'awaitingApproval')) {
			return item;
		}
		changed = true;
		return {
			...item,
			toolCalls: item.toolCalls.map(c =>
				c.status === 'pending' || c.status === 'running' || c.status === 'awaitingApproval'
					? { ...c, status: 'error' as const, summary: c.summary ?? 'Interrupted', approval: undefined }
					: c),
		};
	});
	return changed ? next : items;
}
