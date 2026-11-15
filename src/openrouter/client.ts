import type { Usage } from '../shared/protocol';
import { parseChatStream } from './stream';
import {
	APP_TITLE, APP_URL, extractErrorMessage, isAbortError, mapApiError, normalizeUsage, OpenRouterError,
	type ChatRequest, type RawUsage, type StreamEvent,
} from './types';

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503]);

export interface OpenRouterClientOptions {
	getKey(): Promise<string | undefined>;
	getBaseUrl(): string;
	/** For tests. */
	fetchImpl?: typeof fetch;
	/** For tests: base delay for exponential backoff. */
	retryBaseMs?: number;
}

export interface KeyInfo {
	label?: string;
	usage?: number;
	limit?: number | null;
	isFreeTier?: boolean;
}

export type KeyValidation =
	| { ok: true; info: KeyInfo }
	| { ok: false; reason: 'invalid' | 'network'; message: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new OpenRouterError('aborted', 'Stopped'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new OpenRouterError('aborted', 'Stopped'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			if (value) {
				yield value;
			}
		}
	} finally {
		reader.cancel().catch(() => undefined);
	}
}

function toOpenRouterError(err: unknown, signal?: AbortSignal): OpenRouterError {
	if (err instanceof OpenRouterError) {
		return err;
	}
	if (signal?.aborted || isAbortError(err)) {
		return new OpenRouterError('aborted', 'Stopped');
	}
	const message = err instanceof Error ? err.message : String(err);
	return new OpenRouterError('network', `Could not reach OpenRouter: ${message}`, undefined, true);
}

export class OpenRouterClient {
	constructor(private readonly options: OpenRouterClientOptions) { }

	private get fetch(): typeof fetch {
		return this.options.fetchImpl ?? fetch;
	}

	private baseUrl(): string {
		return this.options.getBaseUrl().replace(/\/+$/, '');
	}

	private headers(key: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${key}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': APP_URL,
			'X-Title': APP_TITLE,
		};
	}

	/** POST with retries for 429/502/503 and network errors. Returns an OK response. */
	private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
		const key = await this.options.getKey();
		if (!key) {
			throw new OpenRouterError('auth', 'No OpenRouter API key is set.');
		}
		const base = this.options.retryBaseMs ?? 1000;
		let lastError: OpenRouterError | undefined;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				const retryAfter = lastError?.retryAfterMs;
				const backoff = retryAfter ?? Math.min(base * 2 ** (attempt - 1), 8 * base) + Math.random() * base * 0.5;
				await sleep(backoff, signal);
			}
			if (signal?.aborted) {
				throw new OpenRouterError('aborted', 'Stopped');
			}
			let res: Response;
			try {
				res = await this.fetch(`${this.baseUrl()}${path}`, {
					method: 'POST',
					headers: this.headers(key),
					body: JSON.stringify(body),
					signal,
				});
			} catch (err) {
				lastError = toOpenRouterError(err, signal);
				if (lastError.code === 'aborted') {
					throw lastError;
				}
				continue;
			}
			if (res.ok) {
				return res;
			}
			const text = await res.text().catch(() => '');
			const err = mapApiError(res.status, extractErrorMessage(text));
			if (!RETRYABLE_STATUS.has(res.status)) {
				throw err;
			}
			const retryAfterSec = Number(res.headers.get('retry-after'));
			if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
				err.retryAfterMs = Math.min(retryAfterSec * 1000, 20_000);
			}
			lastError = err;
		}
		throw lastError ?? new OpenRouterError('unknown', 'Request failed.');
	}

	/** Streams a chat completion. Throws OpenRouterError (code `aborted` when the signal fires). */
	async *chatStream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
		try {
			const res = await this.post('/chat/completions', { ...request, stream: true, usage: { include: true } }, signal);
			if (!res.body) {
				throw new OpenRouterError('unknown', 'OpenRouter returned an empty response.');
			}
			yield* parseChatStream(readBody(res.body as ReadableStream<Uint8Array>));
		} catch (err) {
			throw toOpenRouterError(err, signal);
		}
	}

	/** Non-streaming completion (used for compaction summaries). */
	async chat(request: ChatRequest, signal?: AbortSignal): Promise<{ content: string; usage?: Usage }> {
		try {
			const res = await this.post('/chat/completions', { ...request, stream: false, usage: { include: true } }, signal);
			const json = await res.json() as {
				error?: { code?: number; message?: string };
				choices?: { message?: { content?: string | null } }[];
				usage?: RawUsage;
			};
			if (json.error) {
				throw mapApiError(json.error.code, json.error.message);
			}
			return {
				content: json.choices?.[0]?.message?.content ?? '',
				usage: json.usage ? normalizeUsage(json.usage) : undefined,
			};
		} catch (err) {
			throw toOpenRouterError(err, signal);
		}
	}

	/** Validates a key with `GET /key`. */
	async validateKey(key: string, signal?: AbortSignal): Promise<KeyValidation> {
		let res: Response;
		try {
			res = await this.fetch(`${this.baseUrl()}/key`, { headers: this.headers(key), signal });
		} catch (err) {
			return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err) };
		}
		if (res.status === 401 || res.status === 403) {
			return { ok: false, reason: 'invalid', message: 'Invalid API key.' };
		}
		if (!res.ok) {
			return { ok: false, reason: 'network', message: `OpenRouter returned HTTP ${res.status}.` };
		}
		try {
			const json = await res.json() as { data?: { label?: string; usage?: number; limit?: number | null; is_free_tier?: boolean } };
			return { ok: true, info: { label: json.data?.label, usage: json.data?.usage, limit: json.data?.limit, isFreeTier: json.data?.is_free_tier } };
		} catch {
			return { ok: true, info: {} };
		}
	}

	/** `GET /models` (public, no auth). */
	async fetchModels(signal?: AbortSignal): Promise<unknown> {
		let res: Response;
		try {
			res = await this.fetch(`${this.baseUrl()}/models`, { headers: { 'HTTP-Referer': APP_URL, 'X-Title': APP_TITLE }, signal });
		} catch (err) {
			throw toOpenRouterError(err, signal);
		}
		if (!res.ok) {
			throw mapApiError(res.status, extractErrorMessage(await res.text().catch(() => '')));
		}
		return res.json();
	}
}
