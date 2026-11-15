import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

export interface ScriptedReply {
	text?: string;
	toolCalls?: { name: string; args: unknown }[];
	/** Reply with this HTTP error status instead of a stream. */
	status?: number;
}

interface RecordedRequest {
	model: string;
	messages: { role: string; content: string | null; tool_call_id?: string }[];
	tools?: { function: { name: string } }[];
}

/**
 * Minimal OpenRouter stand-in: serves /models and /key, and answers /chat/completions
 * with scripted SSE replies (split into small pieces like the real API).
 */
export class MockOpenRouter {
	readonly requests: RecordedRequest[] = [];
	private readonly replies: ScriptedReply[] = [];
	private server: http.Server | undefined;
	private callCounter = 0;
	url = '';

	queue(...replies: ScriptedReply[]): void {
		this.replies.push(...replies);
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => void this.handle(req, res));
		await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
		const { port } = this.server.address() as AddressInfo;
		this.url = `http://127.0.0.1:${port}/api/v1`;
	}

	async stop(): Promise<void> {
		await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = req.url ?? '';
		if (req.method === 'GET' && url.endsWith('/models')) {
			const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'models.json'), 'utf8'));
			fixture.data.push({
				id: 'mock/agent', name: 'Mock: Agent', context_length: 100000,
				pricing: { prompt: '0.000001', completion: '0.000002' },
				architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'],
				top_provider: { max_completion_tokens: 4096 },
			});
			return this.json(res, 200, fixture);
		}
		if (req.method === 'GET' && url.endsWith('/key')) {
			return this.json(res, 200, { data: { label: 'test', usage: 0, limit: null } });
		}
		if (req.method === 'POST' && url.endsWith('/chat/completions')) {
			let body = '';
			for await (const chunk of req) {
				body += chunk;
			}
			this.requests.push(JSON.parse(body));
			const reply = this.replies.shift() ?? { text: 'OK' };
			if (reply.status) {
				return this.json(res, reply.status, { error: { code: reply.status, message: `mock error ${reply.status}` } });
			}
			return this.stream(res, reply);
		}
		this.json(res, 404, { error: { message: 'not found' } });
	}

	private json(res: http.ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private stream(res: http.ServerResponse, reply: ScriptedReply): void {
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
		const chunk = (delta: unknown, finish: string | null = null) =>
			send({ id: 'gen-mock', model: 'mock/agent', choices: [{ index: 0, delta, finish_reason: finish }] });

		res.write(': OPENROUTER PROCESSING\n\n');
		if (reply.text) {
			const mid = Math.ceil(reply.text.length / 2);
			chunk({ role: 'assistant', content: reply.text.slice(0, mid) });
			chunk({ content: reply.text.slice(mid) });
		}
		(reply.toolCalls ?? []).forEach((call, index) => {
			const args = JSON.stringify(call.args);
			const mid = Math.ceil(args.length / 2);
			const id = `call_${++this.callCounter}`;
			chunk({ tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }] });
			chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] });
			chunk({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
		});
		chunk({}, reply.toolCalls?.length ? 'tool_calls' : 'stop');
		send({ id: 'gen-mock', model: 'mock/agent', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0001 } });
		res.end('data: [DONE]\n\n');
	}
}
