import type { ChatMessage, ChatRequest, ToolDefinition } from '../openrouter/types';
import type { ModelInfo, Usage } from '../shared/protocol';
import { truncateMiddle } from '../util/text';

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
/** Compact when the estimated prompt reaches this share of the budget. */
export const COMPACT_THRESHOLD = 0.8;
/** Share of the budget the verbatim tail may use after compaction. */
const TAIL_SHARE = 0.3;
const DEFAULT_CONTEXT_LENGTH = 32_000;
const SUMMARY_MAX_TOKENS = 2048;

export function messageChars(m: ChatMessage): number {
	let n = 16;
	if (typeof m.content === 'string') {
		n += m.content.length;
	}
	if (m.role === 'assistant' && m.tool_calls) {
		n += JSON.stringify(m.tool_calls).length;
	}
	return n;
}

export function estimateChars(messages: ChatMessage[], tools?: ToolDefinition[]): number {
	let n = 0;
	for (const m of messages) {
		n += messageChars(m);
	}
	return n + (tools?.length ? JSON.stringify(tools).length : 0);
}

export function estimateTokens(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
	return Math.ceil(chars / (charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN));
}

/** `max_tokens` to send: the setting, capped by the model's own limit and half its context. */
export function effectiveMaxTokens(model: ModelInfo | undefined, setting: number): number {
	let n = setting;
	if (model?.maxCompletionTokens) {
		n = Math.min(n, model.maxCompletionTokens);
	}
	if (model?.contextLength) {
		n = Math.min(n, Math.floor(model.contextLength / 2));
	}
	return Math.max(256, n);
}

/** Prompt budget = context length − reserved output − safety margin. */
export function contextBudget(model: ModelInfo | undefined, maxOutput: number): number {
	const ctx = model?.contextLength || DEFAULT_CONTEXT_LENGTH;
	return Math.max(1024, ctx - maxOutput - Math.max(1024, Math.floor(ctx * 0.05)));
}

/** A split at `i` is valid when it doesn't separate an assistant tool call from its results. */
function isValidSplit(messages: ChatMessage[], i: number): boolean {
	if (messages[i].role === 'tool') {
		return false;
	}
	const prev = messages[i - 1];
	return !(prev.role === 'assistant' && prev.tool_calls?.length);
}

/**
 * Index where the verbatim tail starts: the earliest valid boundary whose tail fits in
 * `tailBudgetChars`, or the latest valid boundary when nothing fits. Undefined when
 * there is too little before it to be worth compacting.
 */
export function findCompactionSplit(messages: ChatMessage[], tailBudgetChars: number): number | undefined {
	let best: number | undefined;
	let tailChars = 0;
	for (let i = messages.length - 1; i >= 1; i--) {
		tailChars += messageChars(messages[i]);
		if (tailChars > tailBudgetChars) {
			break;
		}
		if (isValidSplit(messages, i)) {
			best = i;
		}
	}
	if (best === undefined) {
		for (let i = messages.length - 1; i >= 1; i--) {
			if (isValidSplit(messages, i)) {
				best = i;
				break;
			}
		}
	}
	return best !== undefined && best >= 2 ? best : undefined;
}

export function serializeForSummary(messages: ChatMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		switch (m.role) {
			case 'user':
				parts.push(`USER:\n${m.content}`);
				break;
			case 'assistant': {
				const calls = (m.tool_calls ?? []).map(c => `→ called ${c.function.name}(${truncateMiddle(c.function.arguments, 400)})`);
				parts.push(`ASSISTANT:\n${[m.content ?? '', ...calls].filter(Boolean).join('\n')}`);
				break;
			}
			case 'tool':
				parts.push(`TOOL RESULT:\n${truncateMiddle(m.content, 1500)}`);
				break;
			case 'system':
				break;
		}
	}
	return parts.join('\n\n');
}

const SUMMARY_SYSTEM =
	'You summarize a coding-agent session so the agent can continue with a smaller context. ' +
	'Write plain, dense Markdown. Never invent details that are not in the transcript.';

const SUMMARY_INSTRUCTIONS = `Summarize the session above so the work can continue without it. Include:
1. The user's goals and requests. Quote the most recent request verbatim.
2. Key findings and decisions, with exact identifiers, paths and error messages that matter.
3. Files read, created or modified, and what changed in each.
4. Commands run and their outcomes.
5. What is done, what is in progress, and the next steps.`;

export interface CompactionClient {
	chat(request: ChatRequest, signal?: AbortSignal): Promise<{ content: string; usage?: Usage }>;
}

export interface Compactable {
	messages: ChatMessage[];
	charsPerToken?: number;
}

/**
 * Replaces old messages with a model-written summary and keeps the recent tail verbatim.
 * Returns undefined when there was nothing to compact.
 */
export async function compactMessages(
	session: Compactable,
	client: CompactionClient,
	model: string,
	budgetTokens: number,
	signal?: AbortSignal,
): Promise<{ usage?: Usage; compacted: number } | undefined> {
	const cpt = session.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	const split = findCompactionSplit(session.messages, Math.floor(budgetTokens * TAIL_SHARE * cpt));
	if (split === undefined) {
		return undefined;
	}
	const old = session.messages.slice(0, split);
	const tail = session.messages.slice(split);
	const transcript = truncateMiddle(serializeForSummary(old), Math.floor(budgetTokens * 0.6 * cpt));

	const res = await client.chat({
		model,
		messages: [
			{ role: 'system', content: SUMMARY_SYSTEM },
			{ role: 'user', content: `${transcript}\n\n---\n\n${SUMMARY_INSTRUCTIONS}` },
		],
		max_tokens: SUMMARY_MAX_TOKENS,
	}, signal);

	const summary = res.content.trim() || '(The summary came back empty. Ask the user to restate anything important.)';
	const replacement: ChatMessage[] = [
		{ role: 'user', content: `[Earlier messages in this conversation were compacted to save context. Summary:]\n\n${summary}` },
	];
	if (tail[0]?.role === 'user') {
		replacement.push({ role: 'assistant', content: 'Understood. I have the summary and will continue from there.' });
	}
	session.messages = [...replacement, ...tail];
	return { usage: res.usage, compacted: old.length };
}
