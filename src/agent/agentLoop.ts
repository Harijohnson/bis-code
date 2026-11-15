import * as vscode from 'vscode';
import type { Settings } from '../config/settings';
import type { OpenRouterClient } from '../openrouter/client';
import type { ModelCatalog } from '../openrouter/models';
import {
	isAbortError, OpenRouterError,
	type ChatMessage, type ChatRequest, type StreamEvent, type ToolCall, type ToolDefinition,
} from '../openrouter/types';
import type { Mode, TranscriptEvent, Usage } from '../shared/protocol';
import { workspaceRoots } from '../tools/common';
import type { DiffPreviewProvider } from '../tools/diffPreview';
import type { WorkspaceRoot } from '../tools/pathGuard';
import { ToolRegistry, type AnyTool } from '../tools/registry';
import { errorResult, validateArgs, type ApprovalOutcome, type ToolContext, type ToolResult } from '../tools/types';
import { detectShell } from '../util/shell';
import { newId, truncateMiddle } from '../util/text';
import { suggestPrefix } from './commandPolicy';
import { COMPACT_THRESHOLD, compactMessages, contextBudget, effectiveMaxTokens, estimateChars, estimateTokens } from './context';
import { toolsForMode, type PermissionGate } from './permissions';
import type { Session } from './session';
import { buildSystemPrompt } from './systemPrompt';

export interface AgentDeps {
	client: OpenRouterClient;
	catalog: ModelCatalog;
	settings: Settings;
	gate: PermissionGate;
	diff: DiffPreviewProvider;
	registry: ToolRegistry;
	emit(ev: TranscriptEvent): void;
	getEditor(): vscode.TextEditor | undefined;
}

export interface TurnOptions {
	model: string;
	mode(): Mode;
	autoEdit(): boolean;
	onAcceptAll(): void;
	onAlwaysAllow(prefix: string): Promise<void>;
}

export interface TurnOutcome {
	usage: Usage;
	cost?: number;
	stopped: boolean;
	error?: OpenRouterError;
	/** The model produced text or tool calls during this turn. */
	producedOutput: boolean;
}

/** Tool result text kept in the transcript for the expanded tool card. */
const MAX_DETAIL_CHARS = 5000;

type ParsedArgs ={ ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function parseArgs(raw: string): ParsedArgs {
	try {
		const value: unknown = JSON.parse(raw.trim() === '' ? '{}' : raw);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return { ok: false, error: 'arguments must be a JSON object' };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch (err) {
		return { ok: false, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
	}
}

function toOpenRouterError(err: unknown): OpenRouterError {
	if (err instanceof OpenRouterError) {
		return err;
	}
	if (isAbortError(err)) {
		return new OpenRouterError('aborted', 'Stopped');
	}
	return new OpenRouterError('unknown', err instanceof Error ? err.message : String(err));
}

interface StepResult {
	text: string;
	toolCalls: ToolCall[];
	finishReason?: string;
}

/** Everything a tool call needs from the step that produced it. */
interface StepScope {
	session: Session;
	messageId: string;
	opts: TurnOptions;
	allowed: Set<string>;
	roots: WorkspaceRoot[];
	trusted: boolean;
	signal: AbortSignal;
}

export class AgentLoop {
	constructor(private readonly deps: AgentDeps) { }

	/** Runs model ↔ tool iterations until the model stops calling tools, the user stops, or the step limit is hit. */
	async run(session: Session, opts: TurnOptions, signal: AbortSignal): Promise<TurnOutcome> {
		const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		let cost: number | undefined;
		let producedOutput = false;
		const addUsage = (u: Usage | undefined) => {
			if (!u) {
				return;
			}
			usage.promptTokens += u.promptTokens;
			usage.completionTokens += u.completionTokens;
			usage.totalTokens += u.totalTokens;
			if (u.cost !== undefined) {
				cost = (cost ?? 0) + u.cost;
			}
		};
		const outcome = (extra: Partial<TurnOutcome> = {}): TurnOutcome => ({ usage, cost, producedOutput, stopped: false, ...extra });

		const { settings, catalog, registry } = this.deps;
		const maxIterations = settings.maxIterations;
		try {
			for (let step = 1; ; step++) {
				if (signal.aborted) {
					return outcome({ stopped: true });
				}
				if (step > maxIterations) {
					this.notice(`Stopped after ${maxIterations} steps (bisCode.maxIterations).`, 'continue');
					return outcome();
				}

				const mode = opts.mode();
				const modelInfo = catalog.find(opts.model);
				const roots = workspaceRoots();
				const trusted = vscode.workspace.isTrusted;
				const tools = toolsForMode(mode, trusted, registry.all());
				if (tools.length && modelInfo && !modelInfo.supportsTools) {
					throw new OpenRouterError('model', `${modelInfo.name} can't use tools. Switch to a tool-capable model, or use Chat mode.`);
				}
				const toolDefs = ToolRegistry.definitions(tools);
				const system = buildSystemPrompt({
					mode, trusted, roots,
					shell: detectShell(vscode.env.shell),
					editor: this.deps.getEditor(),
					toolNames: tools.map(t => t.name),
					deniedGlobs: settings.deniedReadGlobs,
				});
				const maxTokens = effectiveMaxTokens(modelInfo, settings.maxOutputTokens);
				const budget = contextBudget(modelInfo, maxTokens);
				await this.maybeCompact(session, opts.model, system, toolDefs, budget, signal, addUsage);

				const messages: ChatMessage[] = [{ role: 'system', content: system }, ...session.messages];
				const promptChars = estimateChars(messages, toolDefs);
				const overBudget = estimateTokens(promptChars, session.charsPerToken) > budget;
				const request: ChatRequest = {
					model: opts.model,
					messages,
					...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' as const } : {}),
					max_tokens: maxTokens,
					...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
					...(overBudget ? { transforms: ['middle-out'] } : {}),
				};

				const messageId = newId('m');
				const result = await this.streamStep(session, request, messageId, opts.model, promptChars, signal, addUsage);
				if (result.text || result.toolCalls.length) {
					producedOutput = true;
				}
				if (!result.toolCalls.length) {
					if (result.finishReason === 'length') {
						this.notice('The response was cut off because it reached the output token limit.', 'continue');
					}
					return outcome();
				}
				const scope: StepScope = { session, messageId, opts, allowed: new Set(tools.map(t => t.name)), roots, trusted, signal };
				await this.executeToolCalls(scope, result.toolCalls);
				if (signal.aborted) {
					return outcome({ stopped: true });
				}
			}
		} catch (err) {
			const e = toOpenRouterError(err);
			return e.code === 'aborted' || signal.aborted ? outcome({ stopped: true }) : outcome({ error: e });
		}
	}

	private notice(text: string, action?: 'continue'): void {
		this.deps.emit({ type: 'transcriptAppend', item: { kind: 'notice', id: newId('n'), text, action } });
	}

	private async maybeCompact(
		session: Session, model: string, system: string, toolDefs: ToolDefinition[], budget: number,
		signal: AbortSignal, addUsage: (u: Usage | undefined) => void,
	): Promise<void> {
		const fixedChars = system.length + (toolDefs.length ? JSON.stringify(toolDefs).length : 0);
		const estimate = estimateTokens(fixedChars + estimateChars(session.messages), session.charsPerToken);
		if (estimate < budget * COMPACT_THRESHOLD) {
			return;
		}
		try {
			const fixedTokens = estimateTokens(fixedChars, session.charsPerToken);
			const result = await compactMessages(session, this.deps.client, model, Math.max(1024, budget - fixedTokens), signal);
			if (result) {
				addUsage(result.usage);
				this.deps.emit({ type: 'transcriptAppend', item: { kind: 'divider', id: newId('d'), text: 'Context compacted' } });
			}
		} catch (err) {
			if (signal.aborted || isAbortError(err)) {
				throw err;
			}
			this.notice(`Couldn't compact the context (${err instanceof Error ? err.message : String(err)}). Continuing with OpenRouter's middle-out fallback.`);
		}
	}

	private async streamStep(
		session: Session, request: ChatRequest, messageId: string, model: string, promptChars: number,
		signal: AbortSignal, addUsage: (u: Usage | undefined) => void,
	): Promise<StepResult> {
		const { emit, client } = this.deps;
		emit({ type: 'assistantStart', messageId, model });
		let text = '';
		let reasoning = '';
		const announced = new Set<string>();
		let done: Extract<StreamEvent, { type: 'done' }> | undefined;

		try {
			for await (const ev of client.chatStream(request, signal)) {
				switch (ev.type) {
					case 'text':
						text += ev.text;
						emit({ type: 'textDelta', messageId, text: ev.text });
						break;
					case 'reasoning':
						reasoning += ev.text;
						emit({ type: 'reasoningDelta', messageId, text: ev.text });
						break;
					case 'toolCallStart':
						if (ev.id && !announced.has(ev.id)) {
							announced.add(ev.id);
							emit({ type: 'toolCall', messageId, callId: ev.id, name: ev.name, args: {}, status: 'pending' });
						}
						break;
					case 'done':
						done = ev;
						break;
				}
			}
		} catch (err) {
			// Keep partial text so the history stays consistent; drop calls that never ran.
			if (text) {
				session.messages.push({ role: 'assistant', content: text });
			}
			for (const id of announced) {
				emit({ type: 'toolResult', callId: id, ok: false, summary: 'Interrupted', status: 'error' });
			}
			if (!text && !reasoning && !announced.size) {
				emit({ type: 'transcriptRemove', id: messageId });
			}
			throw err;
		}
		if (!done) {
			throw new OpenRouterError('network', 'The response ended unexpectedly.', undefined, true);
		}

		addUsage(done.usage);
		if (done.usage?.promptTokens) {
			session.charsPerToken = Math.min(8, Math.max(1.5, promptChars / done.usage.promptTokens));
		}
		const toolCalls = done.toolCalls;
		if (!text && !toolCalls.length) {
			if (!reasoning) {
				emit({ type: 'transcriptRemove', id: messageId });
			}
			if (done.finishReason !== 'length') {
				this.notice('The model returned an empty response.');
			}
			return { text, toolCalls, finishReason: done.finishReason };
		}
		session.messages.push({
			role: 'assistant',
			content: text || null,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			...(done.reasoningDetails ? { reasoning_details: done.reasoningDetails } : {}),
		});
		return { text, toolCalls, finishReason: done.finishReason };
	}

	/** Read-only tools run in parallel batches; mutating tools run one at a time, in order. */
	private async executeToolCalls(scope: StepScope, calls: ToolCall[]): Promise<void> {
		const { emit, registry } = this.deps;
		const parsed = calls.map(c => parseArgs(c.function.arguments));
		calls.forEach((c, i) => {
			const p = parsed[i];
			emit({ type: 'toolCall', messageId: scope.messageId, callId: c.id, name: c.function.name, args: p.ok ? p.value : c.function.arguments, status: 'pending' });
		});

		const results: (ChatMessage | undefined)[] = new Array(calls.length);
		const isReadOnly = (k: number) => registry.get(calls[k].function.name)?.permission === 'auto';
		let i = 0;
		while (i < calls.length && !scope.signal.aborted) {
			if (isReadOnly(i)) {
				let j = i;
				while (j < calls.length && isReadOnly(j)) {
					j++;
				}
				await Promise.all(calls.slice(i, j).map(async (call, n) => {
					results[i + n] = await this.runTool(scope, call, parsed[i + n]);
				}));
				i = j;
			} else {
				results[i] = await this.runTool(scope, calls[i], parsed[i]);
				i++;
			}
		}

		// Every tool call needs a result, or the next request is invalid.
		calls.forEach((c, k) => {
			if (!results[k]) {
				emit({ type: 'toolResult', callId: c.id, ok: false, summary: 'Cancelled', status: 'error' });
				results[k] = { role: 'tool', tool_call_id: c.id, content: 'Cancelled: the user stopped the turn before this tool ran.' };
			}
		});
		scope.session.messages.push(...(results as ChatMessage[]));
	}

	private async runTool(scope: StepScope, call: ToolCall, parsed: ParsedArgs): Promise<ChatMessage> {
		const { emit, registry, settings } = this.deps;
		const name = call.function.name;
		const callId = call.id;
		const finish = (r: ToolResult): ChatMessage => {
			// The expanded card shows what the model received (trimmed for the transcript).
			const detail = r.detail ?? truncateMiddle(r.content, MAX_DETAIL_CHARS);
			emit({ type: 'toolResult', callId, ok: r.ok, summary: r.summary, detail, status: r.status ?? (r.ok ? 'done' : 'error') });
			return { role: 'tool', tool_call_id: callId, content: truncateMiddle(r.content) };
		};

		if (!parsed.ok) {
			return finish(errorResult(`Invalid arguments: ${parsed.error}. Call ${name} again with valid JSON arguments.`, 'Invalid arguments'));
		}
		const tool: AnyTool | undefined = registry.get(name);
		if (!tool) {
			return finish(errorResult(`Unknown tool "${name}". Available tools: ${[...scope.allowed].join(', ') || 'none'}.`, `Unknown tool ${name}`));
		}
		if (!scope.allowed.has(name)) {
			const where = scope.trusted ? `${scope.opts.mode()} mode` : 'an untrusted workspace';
			return finish(errorResult(`${name} is not available in ${where}.`, 'Not available'));
		}
		const invalid = validateArgs(tool.parameters, parsed.value);
		if (invalid) {
			return finish(errorResult(`Invalid arguments: ${invalid}. Check the ${name} schema and try again.`, 'Invalid arguments'));
		}

		const args = parsed.value;
		emit({ type: 'toolCall', messageId: scope.messageId, callId, name, args, status: 'running' });
		const setStatus = (approved: boolean) =>
			emit({ type: 'toolCall', messageId: scope.messageId, callId, name, args, status: approved ? 'running' : 'rejected' });

		const ctx: ToolContext = {
			callId,
			session: scope.session,
			signal: scope.signal,
			roots: scope.roots,
			settings,
			onOutput: chunk => emit({ type: 'toolOutput', callId, chunk }),
			approveEdit: (file, original, proposed, preview) =>
				this.approveEdit(scope, callId, file, original, proposed, preview, setStatus),
			approveCommand: (command, cwdLabel, warning) =>
				this.approveCommand(scope, callId, command, cwdLabel, warning, setStatus),
		};
		try {
			return finish(await tool.execute(args, ctx));
		} catch (err) {
			if (scope.signal.aborted || isAbortError(err)) {
				return finish({ ok: false, content: 'Cancelled: the user stopped the turn.', summary: 'Stopped', status: 'error' });
			}
			return finish(errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'Failed'));
		}
	}

	private async approveEdit(
		scope: StepScope, callId: string, file: vscode.Uri, original: string | undefined, proposed: string, preview: string,
		setStatus: (approved: boolean) => void,
	): Promise<ApprovalOutcome> {
		if (scope.opts.autoEdit()) {
			return { approved: true };
		}
		const { diff, gate, emit } = this.deps;
		await diff.show(callId, file, original, proposed).catch(err => console.error('[bis-code] diff failed', err));
		emit({ type: 'approvalRequest', callId, kind: 'edit', preview });
		const result = await gate.wait(callId, scope.signal);
		await diff.close(callId);
		if (result.aborted) {
			throw new OpenRouterError('aborted', 'Stopped');
		}
		if (result.decision === 'acceptAll') {
			scope.opts.onAcceptAll();
		}
		const approved = result.decision === 'accept' || result.decision === 'acceptAll';
		setStatus(approved);
		return { approved, reason: result.reason };
	}

	private async approveCommand(
		scope: StepScope, callId: string, command: string, cwdLabel: string, warning: string | undefined,
		setStatus: (approved: boolean) => void,
	): Promise<ApprovalOutcome> {
		const { gate, emit } = this.deps;
		// Never offer "Always allow" for a command that touches secrets.
		const allowPrefix = warning ? undefined : suggestPrefix(command);
		const preview = `$ ${command}\n(in ${cwdLabel})${warning ? `\n⚠ ${warning}` : ''}`;
		emit({ type: 'approvalRequest', callId, kind: 'command', preview, allowPrefix });
		const result = await gate.wait(callId, scope.signal);
		if (result.aborted) {
			throw new OpenRouterError('aborted', 'Stopped');
		}
		if (result.decision === 'alwaysAllow' && allowPrefix) {
			await scope.opts.onAlwaysAllow(allowPrefix);
		}
		const approved = result.decision === 'accept' || result.decision === 'alwaysAllow';
		setStatus(approved);
		return { approved, reason: result.reason };
	}
}
