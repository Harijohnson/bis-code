import type { Usage } from '../shared/protocol';
import { mapApiError, normalizeUsage, OpenRouterError, type RawUsage, type ReasoningDetail, type StreamEvent, type ToolCall } from './types';

/**
 * Minimal Server-Sent Events reader. Yields the `data` payload of each event.
 * Skips comment lines (`: OPENROUTER PROCESSING` keep-alives) and other fields.
 */
export async function* sseData(body: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = '';
	let data: string[] = [];

	function* takeLines(final: boolean): Generator<string> {
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			let line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.endsWith('\r')) {
				line = line.slice(0, -1);
			}
			if (line === '') {
				if (data.length) {
					yield data.join('\n');
					data = [];
				}
			} else if (line.startsWith(':')) {
				// SSE comment / keep-alive
			} else if (line.startsWith('data:')) {
				data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
			}
			// `event:`, `id:` and `retry:` fields are not used by OpenRouter chat streams.
		}
		if (final) {
			const rest = buffer.replace(/\r$/, '');
			buffer = '';
			if (rest.startsWith('data:')) {
				data.push(rest.slice(rest.startsWith('data: ') ? 6 : 5));
			}
			if (data.length) {
				yield data.join('\n');
				data = [];
			}
		}
	}

	for await (const chunk of body) {
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		yield* takeLines(false);
	}
	buffer += decoder.decode();
	yield* takeLines(true);
}

interface ToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/**
 * Accumulates streamed `tool_calls` deltas. `id` and `function.name` arrive first,
 * `function.arguments` arrives in string pieces that are concatenated.
 */
export class ToolCallAccumulator {
	private calls: { id: string; name: string; args: string }[] = [];

	/** Adds deltas; returns the indexes of calls that just got their name (newly started). */
	add(deltas: ToolCallDelta[]): { index: number; id: string; name: string }[] {
		const started: { index: number; id: string; name: string }[] = [];
		for (const d of deltas) {
			let index = typeof d.index === 'number' ? d.index : -1;
			if (index < 0) {
				index = d.id ? this.calls.findIndex(c => c.id === d.id) : this.calls.length - 1;
				if (index < 0) {
					index = this.calls.length;
				}
			}
			let call = this.calls[index];
			// Some providers reuse index 0 for every call but send a fresh id.
			if (call && d.id && call.id && d.id !== call.id && (call.name || call.args)) {
				index = this.calls.length;
				call = undefined as unknown as typeof call;
			}
			if (!call) {
				call = { id: '', name: '', args: '' };
				this.calls[index] = call;
			}
			const hadName = call.name !== '';
			if (d.id) {
				call.id = d.id;
			}
			if (d.function?.name) {
				// Names normally arrive whole; a few providers stream them.
				call.name = hadName && call.name !== d.function.name ? call.name + d.function.name : d.function.name;
			}
			if (d.function?.arguments) {
				call.args += d.function.arguments;
			}
			if (!hadName && call.name) {
				started.push({ index, id: call.id, name: call.name });
			}
		}
		return started;
	}

	get size(): number {
		return this.calls.filter(Boolean).length;
	}

	finish(): ToolCall[] {
		return this.calls
			.filter(c => c && c.name)
			.map((c, i) => ({
				id: c.id || `call_${Date.now().toString(36)}_${i}`,
				type: 'function' as const,
				function: { name: c.name, arguments: c.args.trim() === '' ? '{}' : c.args },
			}));
	}
}

/** Merges streamed `reasoning_details` pieces that share an index. */
export class ReasoningDetailsAccumulator {
	private details: ReasoningDetail[] = [];

	add(pieces: ReasoningDetail[]): void {
		for (const piece of pieces) {
			const index = typeof piece.index === 'number' ? piece.index : this.details.length;
			const existing = this.details[index];
			if (!existing || existing.type !== piece.type) {
				this.details[index] = { ...piece };
				continue;
			}
			for (const [key, value] of Object.entries(piece)) {
				if (value === undefined || value === null) {
					continue;
				}
				if ((key === 'text' || key === 'summary' || key === 'data') && typeof value === 'string' && typeof existing[key] === 'string') {
					existing[key] = (existing[key] as string) + value;
				} else {
					existing[key] = value;
				}
			}
		}
	}

	finish(): ReasoningDetail[] | undefined {
		const list = this.details.filter(Boolean);
		return list.length ? list : undefined;
	}
}

interface StreamChunk {
	model?: string;
	error?: { code?: number | string; message?: string };
	usage?: RawUsage;
	choices?: {
		delta?: {
			content?: string | null;
			reasoning?: string | null;
			reasoning_details?: ReasoningDetail[];
			tool_calls?: ToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
}

/**
 * Parses an OpenRouter chat-completions SSE stream into StreamEvents.
 * Errors that arrive inside the stream are thrown as OpenRouterError.
 */
export async function* parseChatStream(body: AsyncIterable<Uint8Array | string>): AsyncGenerator<StreamEvent> {
	const toolCalls = new ToolCallAccumulator();
	const reasoningDetails = new ReasoningDetailsAccumulator();
	let finishReason: string | undefined;
	let usage: Usage | undefined;
	let model: string | undefined;

	for await (const data of sseData(body)) {
		if (data.trim() === '[DONE]') {
			break;
		}
		let chunk: StreamChunk;
		try {
			chunk = JSON.parse(data) as StreamChunk;
		} catch {
			continue;
		}
		if (chunk.error) {
			const status = typeof chunk.error.code === 'number' ? chunk.error.code : Number(chunk.error.code) || undefined;
			const err = mapApiError(status, chunk.error.message ?? 'The model provider returned an error.');
			throw err.code === 'unknown' ? new OpenRouterError('model', err.message, status, err.retryable) : err;
		}
		model ??= chunk.model;
		if (chunk.usage) {
			usage = normalizeUsage(chunk.usage);
		}
		const choice = chunk.choices?.[0];
		if (!choice) {
			continue;
		}
		const delta = choice.delta ?? {};
		if (delta.reasoning) {
			yield { type: 'reasoning', text: delta.reasoning };
		}
		if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
			reasoningDetails.add(delta.reasoning_details);
		}
		if (delta.content) {
			yield { type: 'text', text: delta.content };
		}
		if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
			for (const started of toolCalls.add(delta.tool_calls)) {
				yield { type: 'toolCallStart', ...started };
			}
		}
		if (choice.finish_reason) {
			finishReason = choice.finish_reason;
			if (finishReason === 'error') {
				throw new OpenRouterError('model', 'The model provider returned an error while generating.', undefined, true);
			}
		}
	}

	yield {
		type: 'done',
		finishReason,
		toolCalls: toolCalls.finish(),
		usage,
		model,
		reasoningDetails: reasoningDetails.finish(),
	};
}
