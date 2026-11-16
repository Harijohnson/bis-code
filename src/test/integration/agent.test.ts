import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BisCodeApi } from '../../extension';
import type { TranscriptItem } from '../../shared/protocol';
import { MockOpenRouter } from './mockServer';

const EXTENSION_ID = 'hari72.bis-code';

function toolMessages(req: MockOpenRouter['requests'][number]) {
	return req.messages.filter(m => m.role === 'tool').map(m => m.content ?? '');
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = fn();
		if (value !== undefined) {
			return value;
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error('waitFor timed out');
}

suite('Agent loop against a mock OpenRouter', function () {
	this.timeout(60_000);
	const mock = new MockOpenRouter();
	let api: BisCodeApi;
	let root: string;
	const file = (name: string) => path.join(root, name);

	suiteSetup(async () => {
		await mock.start();
		root = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const cfg = vscode.workspace.getConfiguration('bisCode');
		await cfg.update('baseUrl', mock.url, vscode.ConfigurationTarget.Global);
		await cfg.update('allowedCommands', ['node -e'], vscode.ConfigurationTarget.Global);
		api = await vscode.extensions.getExtension<BisCodeApi>(EXTENSION_ID)!.activate();
		await api.apiKeys.store('sk-or-test');
		await api.catalog.refresh();
		await api.controller.selectModel('mock/agent');
		await api.controller.handle({ type: 'setMode', mode: 'agent' });
	});

	suiteTeardown(async () => {
		const cfg = vscode.workspace.getConfiguration('bisCode');
		await cfg.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
		await cfg.update('allowedCommands', undefined, vscode.ConfigurationTarget.Global);
		await mock.stop();
	});

	setup(async () => {
		await api.controller.newChat();
		await api.controller.handle({ type: 'setAutoEdit', value: false });
	});

	test('loads the model list from the mock server', () => {
		assert.ok(api.catalog.find('mock/agent')?.supportsTools);
	});

	test('reads, then edits a file (auto-edit) and the change lands on disk', async () => {
		fs.writeFileSync(file('hello.txt'), 'hello world\n');
		await api.controller.handle({ type: 'setAutoEdit', value: true });
		const before = mock.requests.length;
		mock.queue(
			{ text: 'Reading.', toolCalls: [{ name: 'read_file', args: { path: 'hello.txt' } }] },
			{ toolCalls: [{ name: 'edit_file', args: { path: 'hello.txt', old_string: 'world', new_string: 'bis-code' } }] },
			{ text: 'Done.' },
		);
		await api.controller.sendMessage('Change world to bis-code', false);

		assert.strictEqual(fs.readFileSync(file('hello.txt'), 'utf8'), 'hello bis-code\n');
		const reqs = mock.requests.slice(before);
		assert.strictEqual(reqs.length, 3);
		assert.match(toolMessages(reqs[1])[0], /1\thello world/);
		assert.match(toolMessages(reqs[2])[1], /Edited hello\.txt/);
		const items = api.controller.getState().session.items;
		assert.ok(items.some(i => i.kind === 'footer'), 'turn footer with usage');
		assert.ok(api.controller.getState().session.totals.cost > 0);
	});

	test('edit without reading first is refused and the file is untouched', async () => {
		fs.writeFileSync(file('unread.txt'), 'original\n');
		await api.controller.handle({ type: 'setAutoEdit', value: true });
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'edit_file', args: { path: 'unread.txt', old_string: 'original', new_string: 'changed' } }] },
			{ text: 'Sorry.' },
		);
		await api.controller.sendMessage('Edit it', false);
		assert.strictEqual(fs.readFileSync(file('unread.txt'), 'utf8'), 'original\n');
		assert.match(toolMessages(mock.requests[before + 1])[0], /must read unread\.txt/);
	});

	test('rejecting an edit sends the reason back to the model', async () => {
		fs.writeFileSync(file('keep.txt'), 'keep me\n');
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'read_file', args: { path: 'keep.txt' } }] },
			{ toolCalls: [{ name: 'write_file', args: { path: 'keep.txt', content: 'replaced\n' } }] },
			{ text: 'Understood.' },
		);
		const turn = api.controller.sendMessage('Rewrite keep.txt', false);
		const callId = await waitFor(() => {
			for (const item of api.controller.getState().session.items as TranscriptItem[]) {
				if (item.kind === 'assistant') {
					const waiting = item.toolCalls.find(c => c.status === 'awaitingApproval');
					if (waiting) {
						return waiting.callId;
					}
				}
			}
			return undefined;
		});
		await api.controller.handle({ type: 'approval', callId, decision: 'reject', reason: 'keep the file as is' });
		await turn;

		assert.strictEqual(fs.readFileSync(file('keep.txt'), 'utf8'), 'keep me\n');
		const feedback = toolMessages(mock.requests[before + 2]).pop()!;
		assert.match(feedback, /rejected this edit/);
		assert.match(feedback, /keep the file as is/);
	});

	test('Plan mode only sends read-only tools; Chat mode sends none', async () => {
		await api.controller.handle({ type: 'setMode', mode: 'plan' });
		mock.queue({ text: 'A plan.' });
		await api.controller.sendMessage('Plan something', false);
		const names = (mock.requests[mock.requests.length - 1].tools ?? []).map(t => t.function.name).sort();
		assert.deepStrictEqual(names, ['explore', 'get_diagnostics', 'glob', 'grep', 'list_dir', 'read_file']);

		await api.controller.handle({ type: 'setMode', mode: 'chat' });
		mock.queue({ text: 'Just chatting.' });
		await api.controller.sendMessage('Hi', false);
		assert.strictEqual(mock.requests[mock.requests.length - 1].tools, undefined);
		await api.controller.handle({ type: 'setMode', mode: 'agent' });
	});

	test('a new chat starts in Agent mode', async () => {
		await api.controller.handle({ type: 'setMode', mode: 'plan' });
		assert.strictEqual(api.controller.getState().mode, 'plan');
		await api.controller.newChat();
		assert.strictEqual(api.controller.getState().mode, 'agent');
	});

	test('secret files and paths outside the workspace are blocked', async () => {
		fs.writeFileSync(file('.env'), 'OPENROUTER_API_KEY=sk-or-should-not-leak\n');
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'read_file', args: { path: '.env' } }, { name: 'read_file', args: { path: '../outside.txt' } }] },
			{ text: 'Blocked.' },
		);
		await api.controller.sendMessage('Show me the env', false);
		const [secret, outside] = toolMessages(mock.requests[before + 1]);
		assert.match(secret, /blocked because it may contain secrets/);
		assert.match(outside, /outside the workspace/);
		assert.ok(!JSON.stringify(mock.requests.slice(before)).includes('sk-or-should-not-leak'));
	});

	test('an allow-listed command runs without approval and returns its output', async () => {
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'run_command', args: { command: 'node -e "console.log(6*7)"' } }] },
			{ text: 'It printed 42.' },
		);
		await api.controller.sendMessage('Run it', false);
		const result = toolMessages(mock.requests[before + 1])[0];
		assert.match(result, /Exit code: 0/);
		assert.match(result, /42/);
	});

	test('denylisted commands are blocked even when allow-listed', async () => {
		await vscode.workspace.getConfiguration('bisCode').update('allowedCommands', ['node -e', 'rm'], vscode.ConfigurationTarget.Global);
		const before = mock.requests.length;
		mock.queue({ toolCalls: [{ name: 'run_command', args: { command: 'rm -rf /' } }] }, { text: 'ok' });
		await api.controller.sendMessage('Clean up', false);
		assert.match(toolMessages(mock.requests[before + 1])[0], /blocked by bis-code's safety rules/);
		await vscode.workspace.getConfiguration('bisCode').update('allowedCommands', ['node -e'], vscode.ConfigurationTarget.Global);
	});

	test('grep can show context lines or list just the matching files', async () => {
		fs.writeFileSync(file('ctx.txt'), 'one\ntwo\nNEEDLE\nfour\nfive\n');
		const before = mock.requests.length;
		mock.queue(
			{
				toolCalls: [
					{ name: 'grep', args: { pattern: 'NEEDLE', path: 'ctx.txt', context_lines: 1 } },
					{ name: 'grep', args: { pattern: 'NEEDLE', files_only: true } },
				],
			},
			{ text: 'Found it.' },
		);
		await api.controller.sendMessage('Find the needle', false);
		const [withContext, filesOnly] = toolMessages(mock.requests[before + 1]);
		assert.strictEqual(withContext, 'ctx.txt-2- two\nctx.txt:3: NEEDLE\nctx.txt-4- four');
		assert.match(filesOnly, /^ctx\.txt$/m);
	});

	test('explore runs a read-only sub-agent and returns its report to the main agent', async () => {
		fs.writeFileSync(file('notes.txt'), 'the answer is 42\n');
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'explore', args: { description: 'Find the answer', prompt: 'What does notes.txt say?' } }] },
			{ toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }] },
			{ text: 'notes.txt:1 says the answer is 42.' },
			{ text: 'The answer is 42.' },
		);
		await api.controller.sendMessage('What is the answer?', false);

		const reqs = mock.requests.slice(before);
		assert.strictEqual(reqs.length, 4);
		const [main1, sub1, sub2, main2] = reqs;
		// The main agent's prompt has the project map and sub-agent guidance.
		assert.match(main1.messages[0].content ?? '', /# Project map/);
		assert.match(main1.messages[0].content ?? '', /# Sub-agents/);
		// The sub-agent gets a fresh conversation, its own role and only read-only tools.
		assert.match(sub1.messages[0].content ?? '', /Role: explore sub-agent/);
		assert.deepStrictEqual(sub1.messages.slice(1).map(m => m.content), ['What does notes.txt say?']);
		const subTools = (sub1.tools ?? []).map(t => t.function.name);
		assert.ok(subTools.includes('read_file'));
		for (const name of ['edit_file', 'write_file', 'run_command', 'explore', 'delegate']) {
			assert.ok(!subTools.includes(name), `sub-agent must not get ${name}`);
		}
		assert.match(toolMessages(sub2)[0], /the answer is 42/);
		// Its final reply comes back to the main agent as the tool result.
		const report = toolMessages(main2)[0];
		assert.match(report, /notes\.txt:1 says the answer is 42/);
		assert.match(report, /agent_id: agent_/);

		const tagged = api.controller.getState().session.items.filter(i => i.kind === 'assistant' && i.agent);
		assert.ok(tagged.length > 0, 'sub-agent messages appear in the transcript');
		assert.ok(tagged.every(i => i.kind === 'assistant' && i.agent?.kind === 'explore' && i.agent.label === 'Find the answer'));
	});

	test('delegate runs a sub-agent that can edit files and reports back', async () => {
		fs.writeFileSync(file('task.txt'), 'status: todo\n');
		await api.controller.handle({ type: 'setAutoEdit', value: true });
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'delegate', args: { description: 'Finish the task', prompt: 'Change todo to done in task.txt' } }] },
			{ toolCalls: [{ name: 'read_file', args: { path: 'task.txt' } }] },
			{ toolCalls: [{ name: 'edit_file', args: { path: 'task.txt', old_string: 'todo', new_string: 'done' } }] },
			{ text: 'Changed task.txt: todo -> done.' },
			// The main agent never read the file itself, so its own edit is refused.
			{ toolCalls: [{ name: 'edit_file', args: { path: 'task.txt', old_string: 'done', new_string: 'shipped' } }] },
			{ text: 'Done.' },
		);
		await api.controller.sendMessage('Finish the task', false);

		assert.strictEqual(fs.readFileSync(file('task.txt'), 'utf8'), 'status: done\n');
		const reqs = mock.requests.slice(before);
		assert.strictEqual(reqs.length, 6);
		assert.match(reqs[1].messages[0].content ?? '', /Role: delegate sub-agent/);
		const subTools = (reqs[1].tools ?? []).map(t => t.function.name);
		assert.ok(subTools.includes('edit_file') && subTools.includes('run_command'), subTools.join(', '));
		assert.ok(!subTools.includes('delegate') && !subTools.includes('explore'), subTools.join(', '));
		assert.match(toolMessages(reqs[4])[0], /Changed task\.txt/);
		assert.match(toolMessages(reqs[5]).at(-1)!, /must read task\.txt/);
	});

	test('a sub-agent continued with its agent_id keeps its context', async () => {
		const before = mock.requests.length;
		mock.queue(
			{ toolCalls: [{ name: 'explore', args: { description: 'First look', prompt: 'Question one' } }] },
			{ text: 'Answer one.' },
			{ text: 'Main done.' },
		);
		await api.controller.sendMessage('Start', false);
		const agentId = /agent_id: (agent_[a-z0-9]+)/.exec(toolMessages(mock.requests[before + 2])[0])?.[1];
		assert.ok(agentId, 'report includes an agent_id');

		mock.queue(
			{ toolCalls: [{ name: 'explore', args: { description: 'Follow-up', prompt: 'Question two', agent_id: agentId } }] },
			{ text: 'Answer two.' },
			{ text: 'Main done again.' },
		);
		await api.controller.sendMessage('Follow up', false);
		const sub = mock.requests[mock.requests.length - 2];
		assert.deepStrictEqual(sub.messages.slice(1).map(m => m.content), ['Question one', 'Answer one.', 'Question two']);

		mock.queue(
			{ toolCalls: [{ name: 'explore', args: { description: 'Lost', prompt: 'Q', agent_id: 'agent_missing' } }] },
			{ text: 'ok' },
		);
		const beforeUnknown = mock.requests.length;
		await api.controller.sendMessage('Unknown agent', false);
		// Same chat, so earlier tool results are in the request too: the newest is last.
		assert.match(toolMessages(mock.requests[beforeUnknown + 1]).at(-1)!, /Unknown agent_id "agent_missing"/);
	});

	test('malformed tool arguments are sent back as an error result', async () => {
		const before = mock.requests.length;
		mock.queue({ toolCalls: [{ name: 'read_file', args: { wrong: 1 } }, { name: 'no_such_tool', args: {} }] }, { text: 'Retrying.' });
		await api.controller.sendMessage('Go', false);
		const [missing, unknown] = toolMessages(mock.requests[before + 1]);
		assert.match(missing, /missing required argument "path"/);
		assert.match(unknown, /Unknown tool "no_such_tool"/);
	});

	test('a 402 shows a credits error; 401 restores the draft and clears the key', async () => {
		mock.queue({ status: 402 });
		await api.controller.sendMessage('Hello', false);
		const last = api.controller.getState().session.items.at(-1)!;
		assert.ok(last.kind === 'error' && last.code === 'credits');

		await api.controller.newChat();
		mock.queue({ status: 401 });
		await api.controller.sendMessage('Keep this draft', false);
		const state = api.controller.getState();
		assert.strictEqual(state.hasApiKey, false);
		assert.ok(!state.session.items.some(i => i.kind === 'user'), 'user message was taken back');
		assert.ok(state.session.items.some(i => i.kind === 'error' && i.code === 'auth'));
		await api.apiKeys.store('sk-or-test');
	});

	test('sessions are saved and can be reloaded', async () => {
		mock.queue({ text: 'Remember me.' });
		await api.controller.sendMessage('A chat worth saving', false);
		const id = api.controller.getState().session.id;
		await api.controller.newChat();
		const listed = api.controller.getState().sessions.find(s => s.id === id);
		assert.ok(listed);
		assert.strictEqual(listed.title, 'A chat worth saving');
		await api.controller.handle({ type: 'loadSession', id });
		const items = api.controller.getState().session.items;
		assert.ok(items.some(i => i.kind === 'assistant' && i.text === 'Remember me.'));
	});
});
