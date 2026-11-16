import * as path from 'path';
import * as vscode from 'vscode';
import type { ApiKeyManager } from '../config/apiKeyManager';
import { Settings } from '../config/settings';
import type { OpenRouterClient } from '../openrouter/client';
import type { ModelCatalog } from '../openrouter/models';
import { shortModelName } from '../shared/format';
import type {
	ActiveContext, AppState, ApprovalDecision, ErrorCode, ExtensionMessage, Mode, TranscriptEvent, WebviewMessage,
} from '../shared/protocol';
import { applyTranscriptEvent } from '../shared/transcript';
import { guardRead, workspaceRoots } from '../tools/common';
import type { DiffPreviewProvider } from '../tools/diffPreview';
import { displayPath, resolveWorkspacePath } from '../tools/pathGuard';
import type { ToolRegistry } from '../tools/registry';
import { isDeniedPath } from '../util/glob';
import { newId, truncateEnd } from '../util/text';
import { AgentLoop } from './agentLoop';
import type { PermissionGate } from './permissions';
import type { ProjectMap } from './projectMap';
import { titleFrom, toView, type Session, type SessionManager } from './session';
import { MANAGE_TRUST_COMMAND, requestWorkspaceTrust } from './trust';

const SELECTED_MODEL_KEY = 'bisCode.selectedModel';
const RECENT_MODELS_KEY = 'bisCode.recentModels';
/** Every window and every new chat starts in this mode; it is not restored from earlier sessions. */
const DEFAULT_MODE: Mode = 'agent';
const MAX_RECENT = 5;
const MAX_ATTACHED_SELECTION = 20_000;

export interface ControllerDeps {
	context: vscode.ExtensionContext;
	settings: Settings;
	apiKeys: ApiKeyManager;
	client: OpenRouterClient;
	catalog: ModelCatalog;
	sessions: SessionManager;
	gate: PermissionGate;
	diff: DiffPreviewProvider;
	registry: ToolRegistry;
	projectMap: ProjectMap;
}

interface Rollback {
	userIndex: number;
	userItemId: string;
	draft: string;
}

/**
 * Owns all chat state. The webview only renders what this posts, and asks for the
 * full state again whenever it is recreated.
 */
export class ChatController implements vscode.Disposable {
	private post: (msg: ExtensionMessage) => void = () => undefined;
	private mode: Mode = DEFAULT_MODE;
	private autoEdit: boolean;
	private hasKey = false;
	private turn: { abort: AbortController; done: Promise<void> } | undefined;
	private lastEditor: vscode.TextEditor | undefined;
	private activeContext: ActiveContext | undefined;
	private selectionTimer: NodeJS.Timeout | undefined;
	private viewReady = false;
	private disposed = false;
	/** Text for the composer that arrived before the webview was ready. */
	private pendingInsert: string | undefined;
	private readonly agent: AgentLoop;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly modelEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeModel = this.modelEmitter.event;

	constructor(private readonly deps: ControllerDeps) {
		this.autoEdit = deps.settings.autoApproveEdits;
		this.agent = new AgentLoop({
			client: deps.client,
			catalog: deps.catalog,
			settings: deps.settings,
			gate: deps.gate,
			diff: deps.diff,
			registry: deps.registry,
			projectMap: deps.projectMap,
			emit: ev => this.emit(ev),
			getEditor: () => this.currentEditor(),
			requestTrust: requestWorkspaceTrust,
		});

		const active = vscode.window.activeTextEditor;
		if (active?.document.uri.scheme === 'file') {
			this.lastEditor = active;
		}
		this.activeContext = this.computeActiveContext();

		this.disposables.push(
			this.modelEmitter,
			deps.apiKeys.onDidChange(() => void this.refreshKeyState()),
			deps.catalog.onDidChange(() => {
				this.post({ type: 'models', models: deps.catalog.models, stale: deps.catalog.stale, error: deps.catalog.error });
				this.modelEmitter.fire();
			}),
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor?.document.uri.scheme === 'file') {
					this.lastEditor = editor;
				}
				this.updateActiveContext();
			}),
			vscode.window.onDidChangeTextEditorSelection(e => {
				if (e.textEditor === this.currentEditor()) {
					clearTimeout(this.selectionTimer);
					this.selectionTimer = setTimeout(() => this.updateActiveContext(), 150);
				}
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.post({ type: 'trust', trusted: true })),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (Settings.affects(e, 'baseUrl')) {
					void deps.catalog.refresh();
				}
				if (Settings.affects(e, 'showOnlyToolModels') || Settings.affects(e, 'defaultModel')) {
					this.postState();
				}
			}),
		);
	}

	async init(): Promise<void> {
		this.hasKey = await this.deps.apiKeys.hasKey();
	}

	setPoster(post: (msg: ExtensionMessage) => void): void {
		this.post = post;
	}

	get running(): boolean {
		return this.turn !== undefined;
	}

	get selectedModel(): string | undefined {
		return this.deps.context.globalState.get<string>(SELECTED_MODEL_KEY) || this.deps.settings.defaultModel;
	}

	get recentModels(): string[] {
		return this.deps.context.globalState.get<string[]>(RECENT_MODELS_KEY, []);
	}

	getState(): AppState {
		const { catalog, sessions, settings } = this.deps;
		return {
			hasApiKey: this.hasKey,
			models: catalog.models,
			modelsStale: catalog.stale,
			modelsError: catalog.error,
			selectedModel: this.selectedModel,
			recentModels: this.recentModels,
			mode: this.mode,
			autoEdit: this.autoEdit,
			running: this.running,
			session: toView(sessions.current),
			sessions: sessions.list(),
			activeContext: this.activeContext,
			trusted: vscode.workspace.isTrusted,
			showOnlyToolModels: settings.showOnlyToolModels,
		};
	}

	postState(): void {
		this.post({ type: 'state', state: this.getState() });
	}

	/** Applies a transcript event to the session (for persistence) and forwards it to the webview. */
	private emit(ev: TranscriptEvent): void {
		const session = this.deps.sessions.current;
		session.transcript = applyTranscriptEvent(session.transcript, ev);
		this.post(ev);
	}

	private emitError(code: ErrorCode, message: string, retryable: boolean): void {
		this.emit({ type: 'error', id: newId('e'), code, message, retryable });
	}

	private postSessions(): void {
		const s = this.deps.sessions.current;
		this.post({ type: 'sessions', sessions: this.deps.sessions.list(), totals: s.totals, title: s.title });
	}

	private async refreshKeyState(): Promise<void> {
		this.hasKey = await this.deps.apiKeys.hasKey();
		this.post({ type: 'apiKey', hasApiKey: this.hasKey });
	}

	async handle(msg: WebviewMessage): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
					this.hasKey = await this.deps.apiKeys.hasKey();
					this.viewReady = true;
					this.postState();
					if (this.pendingInsert) {
						this.post({ type: 'insertText', text: this.pendingInsert });
						this.pendingInsert = undefined;
					}
					break;
				case 'requestApiKey':
					await this.deps.apiKeys.promptAndStore();
					break;
				case 'clearApiKey':
					await this.clearApiKey();
					break;
				case 'sendMessage':
					await this.sendMessage(msg.text, msg.includeActiveFile);
					break;
				case 'stop':
					this.stop();
					break;
				case 'retry':
					await this.retry();
					break;
				case 'continue':
					await this.continueTurn();
					break;
				case 'selectModel':
					await this.selectModel(msg.modelId);
					break;
				case 'refreshModels':
					await this.deps.catalog.refresh();
					break;
				case 'setMode':
					this.setMode(msg.mode);
					break;
				case 'setAutoEdit':
					this.setAutoEdit(msg.value);
					break;
				case 'approval':
					this.resolveApproval(msg.callId, msg.decision, msg.reason);
					break;
				case 'showDiff':
					await this.deps.diff.reveal(msg.callId);
					break;
				case 'newChat':
					await this.newChat();
					break;
				case 'loadSession':
					await this.loadSession(msg.id);
					break;
				case 'deleteSession':
					await this.deleteSession(msg.id);
					break;
				case 'openFile':
					await this.openFile(msg.path, msg.line);
					break;
				case 'insertCode':
					await this.insertCode(msg.code);
					break;
				case 'openExternal':
					await this.openExternal(msg.url);
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'bisCode');
					break;
				case 'requestTrust':
					await vscode.commands.executeCommand(MANAGE_TRUST_COMMAND);
					break;
			}
		} catch (err) {
			console.error('[bis-code] message handler failed', err);
			vscode.window.showErrorMessage(`bis-code: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Turns ────────────────────────────────────────────────────────────────

	async sendMessage(text: string, includeActiveFile: boolean): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || this.turn) {
			return;
		}
		if (!(await this.deps.apiKeys.hasKey())) {
			this.post({ type: 'restoreDraft', text });
			await this.refreshKeyState();
			return;
		}
		if (this.turn) {
			return; // another send started while we awaited; runTurn sets `turn` synchronously
		}
		const model = this.selectedModel;
		if (!model) {
			this.post({ type: 'restoreDraft', text });
			vscode.window.showWarningMessage('bis-code: select a model first.');
			return;
		}

		const session = this.deps.sessions.current;
		const attachment = includeActiveFile ? this.buildAttachment() : undefined;
		if (session.messages.length === 0) {
			session.title = titleFrom(trimmed);
		}
		this.noteModel(session, model);
		session.messages.push({ role: 'user', content: attachment ? `${trimmed}\n\n${attachment.text}` : trimmed });
		const userItemId = newId('u');
		this.emit({ type: 'transcriptAppend', item: { kind: 'user', id: userItemId, text: trimmed, contextLabel: attachment?.label } });
		await this.runTurn(session, model, { userIndex: session.messages.length - 1, userItemId, draft: text });
	}

	/** Adds a "Switched to X" divider when the model changed since the last request. */
	private noteModel(session: Session, model: string): void {
		const last = session.modelHistory[session.modelHistory.length - 1];
		if (last === model) {
			return;
		}
		if (last) {
			const name = this.deps.catalog.find(model)?.name;
			this.emit({ type: 'transcriptAppend', item: { kind: 'divider', id: newId('d'), text: `Switched to ${name ? shortModelName(name) : model}` } });
		}
		session.modelHistory.push(model);
	}

	private async runTurn(session: Session, model: string, rollback?: Rollback): Promise<void> {
		const abort = new AbortController();
		let markDone!: () => void;
		this.turn = { abort, done: new Promise<void>(r => (markDone = r)) };
		this.setRunning(true);
		try {
			const outcome = await this.agent.run(session, {
				model,
				mode: () => this.mode,
				autoEdit: () => this.autoEdit,
				onAcceptAll: () => this.setAutoEdit(true),
				onAlwaysAllow: prefix => this.allowCommandPrefix(prefix),
			}, abort.signal);

			session.totals.promptTokens += outcome.usage.promptTokens;
			session.totals.completionTokens += outcome.usage.completionTokens;
			session.totals.cost += outcome.cost ?? 0;

			const err = outcome.error;
			if (err && err.code !== 'aborted') {
				let retryable = err.retryable || err.code === 'network' || err.code === 'rateLimit';
				if (err.code === 'auth') {
					this.deps.apiKeys.invalidate();
					// Nothing happened yet: take the message back into the composer.
					if (rollback && !outcome.producedOutput && session.messages.length === rollback.userIndex + 1) {
						session.messages.pop();
						if (session.messages.length === 0) {
							session.title = 'New chat';
						}
						this.emit({ type: 'transcriptRemove', id: rollback.userItemId });
						this.post({ type: 'restoreDraft', text: rollback.draft });
					} else {
						retryable = true;
					}
				}
				this.emitError(err.code, err.message, retryable);
			}
			if (outcome.usage.totalTokens > 0 || outcome.stopped) {
				this.emit({
					type: 'turnDone',
					id: newId('f'),
					model,
					usage: outcome.usage.totalTokens > 0 ? outcome.usage : undefined,
					cost: outcome.cost,
					stopped: outcome.stopped,
				});
			}
		} catch (err) {
			console.error('[bis-code] turn failed', err);
			this.emitError('unknown', err instanceof Error ? err.message : String(err), true);
		} finally {
			this.turn = undefined;
			this.setRunning(false);
			markDone();
			session.updatedAt = Date.now();
			await this.deps.sessions.save(session);
			this.postSessions();
		}
	}

	private setRunning(running: boolean): void {
		void vscode.commands.executeCommand('setContext', 'bisCode.running', running);
		this.post({ type: 'running', running });
	}

	stop(): void {
		this.turn?.abort.abort();
	}

	private async stopAndWait(): Promise<void> {
		const turn = this.turn;
		if (turn) {
			turn.abort.abort();
			await turn.done;
		}
	}

	private async retry(): Promise<void> {
		const session = this.deps.sessions.current;
		const model = this.selectedModel;
		if (this.turn || !model || session.messages.length === 0) {
			return;
		}
		const last = session.messages[session.messages.length - 1];
		if (last.role === 'assistant' && !last.tool_calls?.length) {
			session.messages.pop(); // partial answer from the failed attempt
		}
		if (session.messages.length === 0) {
			return;
		}
		this.noteModel(session, model);
		await this.runTurn(session, model);
	}

	private async continueTurn(): Promise<void> {
		const session = this.deps.sessions.current;
		const model = this.selectedModel;
		if (this.turn || !model || session.messages.length === 0) {
			return;
		}
		const last = session.messages[session.messages.length - 1];
		if (last.role === 'assistant') {
			session.messages.push({ role: 'user', content: 'Continue from where you left off.' });
			this.emit({ type: 'transcriptAppend', item: { kind: 'user', id: newId('u'), text: 'Continue' } });
		}
		this.noteModel(session, model);
		await this.runTurn(session, model);
	}

	private resolveApproval(callId: string, decision: ApprovalDecision, reason?: string): void {
		if (!this.deps.gate.resolve(callId, decision, reason)) {
			vscode.window.showInformationMessage('bis-code: that request is no longer waiting for approval.');
		}
	}

	private async allowCommandPrefix(prefix: string): Promise<void> {
		await this.deps.settings.addAllowedCommand(prefix);
		vscode.window.showInformationMessage(`bis-code: commands starting with "${prefix}" will run without asking (bisCode.allowedCommands).`);
	}

	// ── Model, mode, sessions ────────────────────────────────────────────────

	async selectModel(modelId: string): Promise<void> {
		const id = modelId.trim();
		if (!id) {
			return;
		}
		const recent = [id, ...this.recentModels.filter(m => m !== id)].slice(0, MAX_RECENT);
		await this.deps.context.globalState.update(SELECTED_MODEL_KEY, id);
		await this.deps.context.globalState.update(RECENT_MODELS_KEY, recent);
		this.post({ type: 'selectedModel', modelId: id, recentModels: recent });
		this.modelEmitter.fire();
	}

	private setMode(mode: Mode): void {
		this.mode = mode;
		this.post({ type: 'mode', mode });
	}

	private setAutoEdit(value: boolean): void {
		this.autoEdit = value;
		this.post({ type: 'autoEdit', value });
	}

	async newChat(): Promise<void> {
		await this.stopAndWait();
		await this.deps.sessions.save(this.deps.sessions.current);
		this.deps.sessions.newSession();
		this.mode = DEFAULT_MODE;
		this.autoEdit = this.deps.settings.autoApproveEdits;
		this.postState();
	}

	private async loadSession(id: string): Promise<void> {
		if (id === this.deps.sessions.current.id) {
			return;
		}
		await this.stopAndWait();
		await this.deps.sessions.save(this.deps.sessions.current);
		const loaded = await this.deps.sessions.load(id);
		if (!loaded) {
			vscode.window.showWarningMessage('bis-code: that chat could not be loaded.');
		}
		this.autoEdit = this.deps.settings.autoApproveEdits;
		this.postState();
	}

	private async deleteSession(id: string): Promise<void> {
		if (id === this.deps.sessions.current.id) {
			await this.stopAndWait();
		}
		await this.deps.sessions.delete(id);
		this.postState();
	}

	async clearApiKey(): Promise<void> {
		const choice = await vscode.window.showWarningMessage(
			'Remove the stored OpenRouter API key from this machine?', { modal: true }, 'Remove Key');
		if (choice === 'Remove Key') {
			await this.deps.apiKeys.clear();
		}
	}

	// ── Editor integration ───────────────────────────────────────────────────

	currentEditor(): vscode.TextEditor | undefined {
		const active = vscode.window.activeTextEditor;
		if (active?.document.uri.scheme === 'file') {
			return active;
		}
		return this.lastEditor && !this.lastEditor.document.isClosed ? this.lastEditor : undefined;
	}

	private computeActiveContext(): ActiveContext | undefined {
		const editor = this.currentEditor();
		if (!editor) {
			return undefined;
		}
		const roots = workspaceRoots();
		const resolved = resolveWorkspacePath(editor.document.uri.fsPath, roots);
		if (!resolved.ok || isDeniedPath(resolved.relPath, this.deps.settings.deniedReadGlobs)) {
			return undefined;
		}
		const rel = displayPath(resolved, roots);
		const sel = editor.selection;
		const base = path.basename(rel);
		const label = sel.isEmpty ? base : `${base}:${sel.start.line + 1}-${sel.end.line + 1}`;
		return { path: rel, label, hasSelection: !sel.isEmpty };
	}

	private updateActiveContext(): void {
		const next = this.computeActiveContext();
		const prev = this.activeContext;
		if (prev?.path === next?.path && prev?.label === next?.label) {
			return;
		}
		this.activeContext = next;
		this.post({ type: 'activeContext', context: next });
	}

	/** Text appended to the user message for the context chip. */
	private buildAttachment(): { text: string; label: string } | undefined {
		const ctx = this.computeActiveContext();
		const editor = this.currentEditor();
		if (!ctx || !editor) {
			return undefined;
		}
		const sel = editor.selection;
		if (sel.isEmpty) {
			return { label: ctx.label, text: `[The user is looking at ${ctx.path} (cursor on line ${sel.active.line + 1}).]` };
		}
		const code = truncateEnd(editor.document.getText(sel), MAX_ATTACHED_SELECTION);
		return {
			label: ctx.label,
			text: `[Selected code from ${ctx.path}, lines ${sel.start.line + 1}-${sel.end.line + 1}:]\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``,
		};
	}

	/** `bisCode.addSelectionToChat`: quote the selection into the composer. */
	addSelectionToComposer(): boolean {
		const editor = this.currentEditor();
		if (!editor || editor.selection.isEmpty) {
			return false;
		}
		const ctx = this.computeActiveContext();
		const sel = editor.selection;
		const where = ctx ? `${ctx.path}:${sel.start.line + 1}-${sel.end.line + 1}` : 'selection';
		const code = truncateEnd(editor.document.getText(sel), MAX_ATTACHED_SELECTION);
		const text = `${where}\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\`\n`;
		if (this.viewReady) {
			this.post({ type: 'insertText', text });
		} else {
			this.pendingInsert = text;
		}
		return true;
	}

	viewDisposed(): void {
		this.viewReady = false;
	}

	private async openFile(input: string, line?: number): Promise<void> {
		const guarded = guardRead(input, { roots: workspaceRoots(), settings: this.deps.settings });
		if (!guarded.ok) {
			vscode.window.showWarningMessage(`bis-code: ${guarded.error}`);
			return;
		}
		const doc = await vscode.workspace.openTextDocument(guarded.path.uri);
		const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
		await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
	}

	private async insertCode(code: string): Promise<void> {
		const editor = this.currentEditor();
		if (!editor) {
			vscode.window.showWarningMessage('bis-code: open a file to insert code at the cursor.');
			return;
		}
		const target = await vscode.window.showTextDocument(editor.document, editor.viewColumn);
		await target.edit(b => {
			for (const sel of target.selections) {
				b.replace(sel, code);
			}
		});
	}

	private async openExternal(url: string): Promise<void> {
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(url, true);
		} catch {
			return;
		}
		if (!['http', 'https', 'mailto'].includes(uri.scheme)) {
			vscode.window.showWarningMessage(`bis-code: blocked a link with an unsupported scheme (${uri.scheme}:).`);
			return;
		}
		await vscode.env.openExternal(uri);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.turn?.abort.abort();
		clearTimeout(this.selectionTimer);
		for (const d of this.disposables) {
			d.dispose();
		}
		await this.deps.sessions.save(this.deps.sessions.current);
		await this.deps.sessions.flush();
	}
}
