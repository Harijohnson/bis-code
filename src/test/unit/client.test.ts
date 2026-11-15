import * as assert from 'assert';
import { OpenRouterClient } from '../../openrouter/client';
import { mapApiError, OpenRouterError } from '../../openrouter/types';
import { collect, fixture } from './helpers';

function sseResponse(text: string, status = 200): Response {
	return new Response(new Blob([text]).stream(), { status, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function makeClient(responses: (() => Response | Promise<Response>)[], calls: { url: string; init?: RequestInit }[] = []) {
	let i = 0;
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const next = responses[Math.min(i++, responses.length - 1)];
		return next();
	}) as unknown as typeof fetch;
	return new OpenRouterClient({ getKey: async () => 'sk-or-test', getBaseUrl: () => 'https://mock.local/api/v1/', fetchImpl, retryBaseMs: 1 });
}

suite('OpenRouterClient', () => {
	test('streams a chat completion and sends attribution headers + usage.include', async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const client = makeClient([() => sseResponse(fixture('text.sse'))], calls);
		const events = await collect(client.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
		assert.strictEqual(events[events.length - 1].type, 'done');
		assert.strictEqual(calls[0].url, 'https://mock.local/api/v1/chat/completions');
		const headers = calls[0].init!.headers as Record<string, string>;
		assert.strictEqual(headers.Authorization, 'Bearer sk-or-test');
		assert.strictEqual(headers['X-Title'], 'bis-code');
		assert.ok(headers['HTTP-Referer']);
		const body = JSON.parse(calls[0].init!.body as string);
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.usage, { include: true });
	});

	test('retries 429 and 503, then succeeds', async () => {
		const calls: { url: string }[] = [];
		const client = makeClient([
			() => jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' }),
			() => jsonResponse({ error: { message: 'down' } }, 503),
			() => sseResponse(fixture('text.sse')),
		], calls);
		const events = await collect(client.chatStream({ model: 'm', messages: [] }));
		assert.strictEqual(calls.length, 3);
		assert.strictEqual(events[events.length - 1].type, 'done');
	});

	test('gives up after 3 retries with a retryable error', async () => {
		const calls: { url: string }[] = [];
		const client = makeClient([() => jsonResponse({ error: { message: 'rate limited' } }, 429)], calls);
		await assert.rejects(collect(client.chatStream({ model: 'm', messages: [] })),
			(e: unknown) => e instanceof OpenRouterError && e.code === 'rateLimit' && e.retryable);
		assert.strictEqual(calls.length, 4);
	});

	test('401 is not retried and maps to auth', async () => {
		const calls: { url: string }[] = [];
		const client = makeClient([() => jsonResponse({ error: { message: 'No auth credentials found' } }, 401)], calls);
		await assert.rejects(collect(client.chatStream({ model: 'm', messages: [] })), (e: unknown) => e instanceof OpenRouterError && e.code === 'auth');
		assert.strictEqual(calls.length, 1);
	});

	test('abort during the request maps to code "aborted"', async () => {
		const controller = new AbortController();
		let fetched!: () => void;
		const started = new Promise<void>(r => (fetched = r));
		const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
			fetched();
		})) as unknown as typeof fetch;
		const client = new OpenRouterClient({ getKey: async () => 'k', getBaseUrl: () => 'https://x', fetchImpl });
		const pending = collect(client.chatStream({ model: 'm', messages: [] }, controller.signal));
		await started;
		controller.abort();
		await assert.rejects(pending, (e: unknown) => e instanceof OpenRouterError && e.code === 'aborted');
	});

	test('an already-aborted signal never sends a request', async () => {
		let called = false;
		const controller = new AbortController();
		controller.abort();
		const client = new OpenRouterClient({
			getKey: async () => 'k',
			getBaseUrl: () => 'https://x',
			fetchImpl: (async () => {
				called = true;
				return sseResponse('');
			}) as unknown as typeof fetch,
		});
		await assert.rejects(collect(client.chatStream({ model: 'm', messages: [] }, controller.signal)),
			(e: unknown) => e instanceof OpenRouterError && e.code === 'aborted');
		assert.strictEqual(called, false);
	});

	test('no key → auth error without a request', async () => {
		let called = false;
		const client = new OpenRouterClient({
			getKey: async () => undefined,
			getBaseUrl: () => 'https://x',
			fetchImpl: (async () => {
				called = true;
				return sseResponse('');
			}) as unknown as typeof fetch,
		});
		await assert.rejects(collect(client.chatStream({ model: 'm', messages: [] })), (e: unknown) => e instanceof OpenRouterError && e.code === 'auth');
		assert.strictEqual(called, false);
	});

	test('validateKey distinguishes invalid keys from network errors', async () => {
		const ok = makeClient([() => jsonResponse({ data: { label: 'k', usage: 1.5, limit: 10 } }, 200)]);
		assert.deepStrictEqual(await ok.validateKey('k'), { ok: true, info: { label: 'k', usage: 1.5, limit: 10, isFreeTier: undefined } });
		const bad = makeClient([() => jsonResponse({ error: { message: 'bad' } }, 401)]);
		assert.strictEqual((await bad.validateKey('k')).ok, false);
		const offline = new OpenRouterClient({
			getKey: async () => 'k', getBaseUrl: () => 'https://x',
			fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
		});
		const res = await offline.validateKey('k');
		assert.ok(!res.ok && res.reason === 'network');
	});
});

suite('mapApiError', () => {
	test('maps statuses per the plan', () => {
		assert.strictEqual(mapApiError(401, '').code, 'auth');
		assert.strictEqual(mapApiError(402, '').code, 'credits');
		assert.ok(mapApiError(429, '').retryable);
		assert.ok(mapApiError(502, '').retryable);
		assert.ok(mapApiError(503, '').retryable);
		const tools = mapApiError(404, 'No endpoints found that support tool use. Try disabling "read_file".');
		assert.strictEqual(tools.code, 'model');
		assert.match(tools.message, /can't use tools/);
		assert.strictEqual(mapApiError(400, 'context length exceeded').code, 'model');
	});
});
