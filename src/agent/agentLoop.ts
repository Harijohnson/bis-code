import * as vscode from 'vscode';
import type { Settings } from '../config/settings';
import type { OpenRouterClient } from '../openrouter/client';
import type { ModelCatalog } from '../openrouter/models';
import {
	isAbortError, OpenRouterError,
	type ChatMessage, type ChatRequest, type StreamEvent, type ToolCall, type ToolDefinition,
} from '../openrouter/types';
import type { AgentTag, Mode, TranscriptEvent, Usage } from '../shared/protocol';
import { workspaceRoots } from '../tools/common';
import type { DiffPreviewProvider } from '../tools/diffPreview';
import type { WorkspaceRoot } from '../tools/pathGuard';
import { ToolRegistry, type AnyTool } from '../tools/registry';
import {
	errorResult, validateArgs,
	type ApprovalOutcome, type SubagentRequest, type ToolContext, type ToolResult,
} from '../tools/types';
import { detectShell } from '../util/shell';
import { newId, pluralize, truncateMiddle } from '../util/text';
import { suggestPrefix } from './commandPolicy';
import { COMPACT_THRESHOLD, compactMessages, contextBudget, effectiveMaxTokens, estimateChars, estimateTokens } from './context';
import { needsTrust, toolsForMode, toolsForSubagent, type PermissionGate } from './permissions';
import type { ProjectMap } from './projectMap';
import type { Session } from './session';
import { buildSystemPrompt } from './systemPrompt';

export interface AgentDeps {
	client: OpenRouterClient;
	catalog: ModelCatalog;
	settings: Settings;
	gate: PermissionGate;
	diff: DiffPreviewProvider;
	registry: ToolRegistry;
	projectMap: Pick<ProjectMap, 'refresh' | 'promptText'>;
	emit(ev: TranscriptEvent): void;
	getEditor(): vscode.TextEditor | undefined;
	/** Asks the user to trust the workspace so the agent can `action`; resolves true once it is trusted. */
	requestTrust(action: string, signal: AbortSignal): Promise<boolean>;
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
/** Sub-agents that may run at the same time; further parallel explore calls wait for a slot. */
const MAX_PARALLEL_SUBAGENTS = 3;

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

/** Messages and read tracking for one agent: the session itself, or a sub-agent's own conversation. */
interface Conversation {
	messages: ChatMessage[];
	/** Each agent must read a file itself before changing it (see ReadTracker). */
	readFiles: Record<string, number>;
	charsPerToken?: number;
}

interface Subagent extends Conversation {
	tag: AgentTag;
	/** A run is in progress, so it can't take a follow-up yet. */
	busy: boolean;
}

/** Per-turn state shared by the main agent and its sub-agents. */
interface TurnState {
	usage: Usage;
	cost?: number;
	producedOutput: boolean;
	/** The user declined to trust the workspace during this turn, so don't ask again. */
	trustDeclined: boolean;
}

/** One agent's run within a turn: the main agent, or a sub-agent when `agent` is set. */
interface LoopScope {
	/** Owns the transcript. Sub-agents keep their messages in `convo`. */
	session: Session;
	convo: Conversation;
	opts: TurnOptions;
	turn: TurnState;
	signal: AbortSignal;
	agent?: Subagent;
}

/** Everything a tool call needs from the step that produced it. */
interface StepScope extends LoopScope {
	messageId: string;
	allowed: Set<string>;
	roots: WorkspaceRoot[];
}

interface LoopEnd {
	/** done: the model stopped calling tools. cutOff: its last reply hit the output token limit. */
	reason: 'done' | 'stopped' | 'maxSteps' | 'cutOff';
	/** The last non-empty text the model wrote; a sub-agent's report. */
	text: string;
	steps: number;
}

/** Counting semaphore that limits how many sub-agents run at once. */
class Slots {
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly max: number) { }

	async acquire(): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return;
		}
		await new Promise<void>(resolve => {
			this.waiting.push(resolve);
		});
	}

	/** Hands the slot to the next waiter, if any. */
	release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.active--;
		}
	}
}

function subagentResult(agent: Subagent, end: LoopEnd, maxSteps: number): ToolResult {
	const { id, kind, label } = agent.tag;
	const notes: string[] = [];
	if (end.reason === 'maxSteps') {
		notes.push(`[The sub-agent stopped at the step limit (${maxSteps}) before finishing. Send it a follow-up with agent_id to let it continue.]`);
	} else if (end.reason === 'cutOff') {
		notes.push('[Its last reply was cut off by the output token limit.]');
	}
	notes.push(`[agent_id: ${id}. Pass it to ${kind} to send this sub-agent a follow-up; it keeps its context.]`);
	const report = end.text.trim() || '(The sub-agent finished without writing a report.)';
	return {
		ok: true,
		content: `${report}\n\n${notes.join('\n')}`,
		summary: `${kind === 'explore' ? 'Explored' : 'Delegated'}: ${label} (${pluralize(end.steps, 'step')})`,
	};
}

export class AgentLoop {
	/** Sub-agents by id, per chat, so the main agent can send them follow-ups. Kept in memory only. */
	private readonly subagents = new WeakMap<Session, Map<string, Subagent>>();
	private readonly subagentSlots = new Slots(MAX_PARALLEL_SUBAGENTS);

	constructor(private readonly deps: AgentDeps) { }

	/** Runs model ↔ tool iterations until the model stops calling tools, the user stops, or the step limit is hit. */
	async run(session: Session, opts: TurnOptions, signal: AbortSignal): Promise<TurnOutcome> {
		const turn: TurnState = {
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			producedOutput: false,
			trustDeclined: false,
		};
		const outcome = (extra: Partial<TurnOutcome> = {}): TurnOutcome =>
			({ usage: turn.usage, cost: turn.cost, producedOutput: turn.producedOutput, stopped: false, ...extra });
		try {
			const end = await this.loop({ session, convo: session, opts, turn, signal });
			switch (end.reason) {
				case 'stopped':
					return outcome({ stopped: true });
				case 'maxSteps':
					this.notice(`Stopped after ${end.steps} steps (bisCode.maxIterations).`, 'continue');
					break;
				case 'cutOff':
					this.notice('The response was cut off because it reached the output token limit.', 'continue');
					break;
			}
			return outcome();
		} catch (err) {
			const e = toOpenRouterError(err);
			return e.code === 'aborted' || signal.aborted ? outcome({ stopped: true }) : outcome({ error: e });
		}
	}

	/** The model ↔ tool loop shared by the main agent and sub-agents. Throws on API errors. */
	private async loop(scope: LoopScope): Promise<LoopEnd> {
		const { settings, catalog, registry, projectMap } = this.deps;
		const { convo, opts, signal, agent } = scope;
		const addUsage = (u: Usage | undefined) => this.addUsage(scope.turn, u);
		let text = '';
		for (let step = 1; ; step++) {
			if (signal.aborted) {
				return { reason: 'stopped', text, steps: step - 1 };
			}
			if (step > settings.maxIterations) {
				return { reason: 'maxSteps', text, steps: step - 1 };
			}

			const mode = opts.mode();
			const modelInfo = catalog.find(opts.model);
			const roots = workspaceRoots();
			const modeTools = toolsForMode(mode, registry.all());
			const tools = agent ? toolsForSubagent(agent.tag.kind, modeTools) : modeTools;
			if (tools.length && modelInfo && !modelInfo.supportsTools) {
				throw new OpenRouterError('model', `${modelInfo.name} can't use tools. Switch to a tool-capable model, or use Chat mode.`);
			}
			const toolDefs = ToolRegistry.definitions(tools);
			if (tools.length) {
				await projectMap.refresh();
			}
			const system = buildSystemPrompt({
				mode,
				trusted: vscode.workspace.isTrusted,
				roots,
				shell: detectShell(vscode.env.shell),
				editor: this.deps.getEditor(),
				toolNames: tools.map(t => t.name),
				deniedGlobs: settings.deniedReadGlobs,
				projectMap: projectMap.promptText(),
				subagent: agent?.tag.kind,
			});
			const maxTokens = effectiveMaxTokens(modelInfo, settings.maxOutputTokens);
			const budget = contextBudget(modelInfo, maxTokens);
			await this.maybeCompact(convo, opts.model, system, toolDefs, budget, signal, addUsage, agent?.tag);

			const messages: ChatMessage[] = [{ role: 'system', content: system }, ...convo.messages];
			const promptChars = estimateChars(messages, toolDefs);
			const overBudget = estimateTokens(promptChars, convo.charsPerToken) > budget;
			const request: ChatRequest = {
				model: opts.model,
				messages,
				...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' as const } : {}),
				max_tokens: maxTokens,
				...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
				...(overBudget ? { transforms: ['middle-out'] } : {}),
			};

			const messageId = newId('m');
			const result = await this.streamStep(convo, request, messageId, opts.model, promptChars, signal, addUsage, agent?.tag);
			if (result.text || result.toolCalls.length) {
				scope.turn.producedOutput = true;
			}
			if (result.text.trim()) {
				text = result.text;
			}
			if (!result.toolCalls.length) {
				return { reason: result.finishReason === 'length' ? 'cutOff' : 'done', text, steps: step };
			}
			await this.executeToolCalls({ ...scope, messageId, allowed: new Set(tools.map(t => t.name)), roots }, result.toolCalls);
			if (signal.aborted) {
				return { reason: 'stopped', text, steps: step };
			}
		}
	}

	private addUsage(turn: TurnState, u: Usage | undefined): void {
		if (!u) {
			return;
		}
		turn.usage.promptTokens += u.promptTokens;
		turn.usage.completionTokens += u.completionTokens;
		turn.usage.totalTokens += u.totalTokens;
		if (u.cost !== undefined) {
			turn.cost = (turn.cost ?? 0) + u.cost;
		}
	}

	private notice(text: string, action?: 'continue'): void {
		this.deps.emit({ type: 'transcriptAppend', item: { kind: 'notice', id: newId('n'), text, action } });
	}

	private async maybeCompact(
		convo: Conversation, model: string, system: string, toolDefs: ToolDefinition[], budget: number,
		signal: AbortSignal, addUsage: (u: Usage | undefined) => void, tag?: AgentTag,
	): Promise<void> {
		const fixedChars = system.length + (toolDefs.length ? JSON.stringify(toolDefs).length : 0);
		const estimate = estimateTokens(fixedChars + estimateChars(convo.messages), convo.charsPerToken);
		if (estimate < budget * COMPACT_THRESHOLD) {
			return;
		}
		try {
			const fixedTokens = estimateTokens(fixedChars, convo.charsPerToken);
			const result = await compactMessages(convo, this.deps.client, model, Math.max(1024, budget - fixedTokens), signal);
			if (result) {
				addUsage(result.usage);
				const text = tag ? `Context compacted (${tag.label})` : 'Context compacted';
				this.deps.emit({ type: 'transcriptAppend', item: { kind: 'divider', id: newId('d'), text } });
			}
		} catch (err) {
			if (signal.aborted || isAbortError(err)) {
				throw err;
			}
			this.notice(`Couldn't compact the context (${err instanceof Error ? err.message : String(err)}). Continuing with OpenRouter's middle-out fallback.`);
		}
	}

	private async streamStep(
		convo: Conversation, request: ChatRequest, messageId: string, model: string, promptChars: number,
		signal: AbortSignal, addUsage: (u: Usage | undefined) => void, tag?: AgentTag,
	): Promise<StepResult> {
		const { emit, client } = this.deps;
		emit({ type: 'assistantStart', messageId, model, agent: tag });
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
				convo.messages.push({ role: 'assistant', content: text });
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
			convo.charsPerToken = Math.min(8, Math.max(1.5, promptChars / done.usage.promptTokens));
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
		convo.messages.push({
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
		scope.convo.messages.push(...(results as ChatMessage[]));
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
		const stopped = () => finish({ ok: false, content: 'Cancelled: the user stopped the turn.', summary: 'Stopped', status: 'error' });

		if (!parsed.ok) {
			return finish(errorResult(`Invalid arguments: ${parsed.error}. Call ${name} again with valid JSON arguments.`, 'Invalid arguments'));
		}
		const tool: AnyTool | undefined = registry.get(name);
		if (!tool) {
			return finish(errorResult(`Unknown tool "${name}". Available tools: ${[...scope.allowed].join(', ') || 'none'}.`, `Unknown tool ${name}`));
		}
		if (!scope.allowed.has(name)) {
			const where = scope.agent ? `to ${scope.agent.tag.kind} sub-agents` : `in ${scope.opts.mode()} mode`;
			return finish(errorResult(`${name} is not available ${where}.`, 'Not available'));
		}
		const invalid = validateArgs(tool.parameters, parsed.value);
		if (invalid) {
			return finish(errorResult(`Invalid arguments: ${invalid}. Check the ${name} schema and try again.`, 'Invalid arguments'));
		}

		const args = parsed.value;
		if (needsTrust(tool) && !vscode.workspace.isTrusted) {
			// Restricted Mode: ask the user to trust the workspace instead of failing silently.
			emit({ type: 'toolCall', messageId: scope.messageId, callId, name, args, status: 'awaitingApproval' });
			const action = tool.permission === 'command' ? 'run commands' : 'edit files';
			const trusted = !scope.turn.trustDeclined && await this.deps.requestTrust(action, scope.signal);
			if (scope.signal.aborted) {
				return stopped();
			}
			if (!trusted) {
				scope.turn.trustDeclined = true;
				return finish(errorResult(
					`${name} needs a trusted workspace, and the user did not trust this one. Don't retry edits or commands in this turn: ` +
					'continue read-only and describe the changes you would make.',
					'Workspace not trusted'));
			}
		}

		emit({ type: 'toolCall', messageId: scope.messageId, callId, name, args, status: 'running' });
		const setStatus = (approved: boolean) =>
			emit({ type: 'toolCall', messageId: scope.messageId, callId, name, args, status: approved ? 'running' : 'rejected' });

		const ctx: ToolContext = {
			callId,
			session: scope.convo,
			signal: scope.signal,
			roots: scope.roots,
			settings,
			onOutput: chunk => emit({ type: 'toolOutput', callId, chunk }),
			approveEdit: (file, original, proposed, preview) =>
				this.approveEdit(scope, callId, file, original, proposed, preview, setStatus),
			approveCommand: (command, cwdLabel, warning) =>
				this.approveCommand(scope, callId, command, cwdLabel, warning, setStatus),
			runSubagent: scope.agent ? undefined : request => this.runSubagent(scope, request),
		};
		try {
			return finish(await tool.execute(args, ctx));
		} catch (err) {
			if (scope.signal.aborted || isAbortError(err)) {
				return stopped();
			}
			return finish(errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, 'Failed'));
		}
	}

	/** Runs a sub-agent inside the current turn (sharing its usage, approvals and Stop) and returns its report. */
	private async runSubagent(parent: StepScope, request: SubagentRequest): Promise<ToolResult> {
		let agents = this.subagents.get(parent.session);
		if (!agents) {
			agents = new Map();
			this.subagents.set(parent.session, agents);
		}
		let agent: Subagent;
		if (request.agentId) {
			const existing = agents.get(request.agentId);
			if (!existing) {
				return errorResult(
					`Unknown agent_id "${request.agentId}". Sub-agents only last for this chat while VS Code stays open; start a new one without agent_id.`,
					'Unknown sub-agent');
			}
			if (existing.tag.kind !== request.kind) {
				return errorResult(`agent_id "${request.agentId}" is a ${existing.tag.kind} sub-agent; continue it with the ${existing.tag.kind} tool.`, 'Wrong sub-agent type');
			}
			if (existing.busy) {
				return errorResult(`Sub-agent "${request.agentId}" is still working on another request.`, 'Sub-agent busy');
			}
			agent = existing;
		} else {
			agent = {
				tag: { id: newId('agent_'), kind: request.kind, label: request.description || 'Sub-agent task' },
				messages: [],
				readFiles: {},
				charsPerToken: parent.session.charsPerToken,
				busy: false,
			};
			agents.set(agent.tag.id, agent);
		}

		// Set before the first await so a parallel follow-up to the same agent sees it.
		agent.busy = true;
		agent.messages.push({ role: 'user', content: request.prompt });
		await this.subagentSlots.acquire();
		try {
			const end = await this.loop({ session: parent.session, convo: agent, opts: parent.opts, turn: parent.turn, signal: parent.signal, agent });
			if (end.reason === 'stopped') {
				throw new OpenRouterError('aborted', 'Stopped');
			}
			return subagentResult(agent, end, this.deps.settings.maxIterations);
		} catch (err) {
			if (parent.signal.aborted || isAbortError(err)) {
				throw err;
			}
			return errorResult(`The ${agent.tag.kind} sub-agent failed: ${toOpenRouterError(err).message}`, 'Sub-agent failed');
		} finally {
			agent.busy = false;
			this.subagentSlots.release();
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
