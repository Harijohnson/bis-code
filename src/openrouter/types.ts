import type { ErrorCode, Usage } from '../shared/protocol';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Sent as HTTP-Referer for OpenRouter app attribution. */
export const APP_URL = 'https://github.com/Harijohnson/bis-code';
export const APP_TITLE = 'bis-code';

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/** OpenRouter reasoning detail block (passed back so providers can continue reasoning across tool calls). */
export type ReasoningDetail = Record<string, unknown> & { type: string };

export type ChatMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: ReasoningDetail[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export interface JsonSchema {
	type: 'object';
	properties: Record<string, { type: string; description?: string; items?: { type: string }; enum?: string[] }>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface ToolDefinition {
	type: 'function';
	function: { name: string; description: string; parameters: JsonSchema };
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	tool_choice?: 'auto' | 'none';
	max_tokens?: number;
	temperature?: number;
	transforms?: string[];
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'content_filter' | (string & {});

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'toolCallStart'; index: number; id: string; name: string }
	| {
		type: 'done';
		finishReason: FinishReason | undefined;
		toolCalls: ToolCall[];
		usage?: Usage;
		model?: string;
		reasoningDetails?: ReasoningDetail[];
	};

export type OpenRouterErrorCode = ErrorCode | 'aborted';

export class OpenRouterError extends Error {
	/** From a `Retry-After` header, when the server sent one. */
	retryAfterMs?: number;

	constructor(
		readonly code: OpenRouterErrorCode,
		message: string,
		readonly status?: number,
		readonly retryable = false,
	) {
		super(message);
		this.name = 'OpenRouterError';
	}
}

export function isAbortError(err: unknown): boolean {
	return err instanceof OpenRouterError
		? err.code === 'aborted'
		: err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError');
}

/** Raw usage object as sent by OpenRouter. */
export interface RawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	cost?: number;
}

export function normalizeUsage(raw: RawUsage): Usage {
	const promptTokens = raw.prompt_tokens ?? 0;
	const completionTokens = raw.completion_tokens ?? 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
		cost: typeof raw.cost === 'number' ? raw.cost : undefined,
	};
}

const TOOLS_UNSUPPORTED = /tool use|tools? (are|is)? ?not supported|does not support tools|support tool/i;

/**
 * Maps an HTTP status + response body (or an in-stream `error` object) to an OpenRouterError.
 */
export function mapApiError(status: number | undefined, message: string | undefined): OpenRouterError {
	const msg = (message ?? '').trim();
	switch (status) {
		case 401:
			return new OpenRouterError('auth', 'Your OpenRouter API key is invalid or was revoked.', status);
		case 402:
			return new OpenRouterError('credits', 'Your OpenRouter account is out of credits. Add credits at https://openrouter.ai/credits.', status);
		case 429:
			return new OpenRouterError('rateLimit', msg || 'Rate limited by OpenRouter or the model provider.', status, true);
		case 502:
		case 503:
		case 504:
			return new OpenRouterError('model', msg || 'The model provider is unavailable right now.', status, true);
		case 408:
			return new OpenRouterError('network', msg || 'The request timed out.', status, true);
	}
	if ((status === 400 || status === 404) && TOOLS_UNSUPPORTED.test(msg)) {
		return new OpenRouterError('model', "This model can't use tools. Switch to a tool-capable model or use Chat mode.", status);
	}
	if (status === 400 || status === 404 || status === 413) {
		return new OpenRouterError('model', msg || `The request was rejected (HTTP ${status}).`, status);
	}
	return new OpenRouterError('unknown', msg || (status ? `OpenRouter returned HTTP ${status}.` : 'Unknown error.'), status, status !== undefined && status >= 500);
}

/** Extracts `error.message` from an OpenRouter JSON error body, falling back to the raw text. */
export function extractErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; metadata?: { raw?: string } } };
		const raw = parsed.error?.metadata?.raw;
		const base = parsed.error?.message ?? body;
		return raw && typeof raw === 'string' && !base.includes(raw) ? `${base}: ${raw.slice(0, 500)}` : base;
	} catch {
		return body.slice(0, 500);
	}
}
