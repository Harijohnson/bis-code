// Message protocol shared by the extension host and the webview bundle.
// Keep this file free of `vscode`, Node and DOM imports: both sides compile it.

export type Mode = 'agent' | 'plan' | 'chat';

/** explore: read-only research. delegate: may edit files and run commands (with approvals). */
export type SubagentKind = 'explore' | 'delegate';

/** Marks a transcript message written by a sub-agent. */
export interface AgentTag {
	id: string;
	kind: SubagentKind;
	/** Short task label given by the main agent. */
	label: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	description: string;
	/** Part of the id before the `/`, e.g. `anthropic`. */
	provider: string;
	contextLength: number;
	/** USD per token. -1 means variable pricing (routers). */
	promptPrice: number;
	completionPrice: number;
	inputModalities: string[];
	supportedParameters: string[];
	maxCompletionTokens?: number;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsReasoning: boolean;
	isFree: boolean;
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** USD, as reported by OpenRouter. */
	cost?: number;
}

export type ToolStatus = 'pending' | 'awaitingApproval' | 'running' | 'done' | 'error' | 'rejected';

export type ApprovalKind = 'edit' | 'command';

export interface ApprovalView {
	kind: ApprovalKind;
	preview: string;
	/** For commands: the prefix offered by "Always allow". */
	allowPrefix?: string;
}

export interface ToolCallView {
	callId: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	summary?: string;
	detail?: string;
	/** Streaming output (run_command). */
	output?: string;
	approval?: ApprovalView;
}

export type ErrorCode = 'auth' | 'credits' | 'rateLimit' | 'network' | 'model' | 'unknown';

export type TranscriptItem =
	| { kind: 'user'; id: string; text: string; contextLabel?: string }
	| { kind: 'assistant'; id: string; model: string; text: string; reasoning: string; toolCalls: ToolCallView[]; agent?: AgentTag }
	| { kind: 'footer'; id: string; model: string; usage?: Usage; cost?: number; stopped?: boolean }
	| { kind: 'divider'; id: string; text: string }
	| { kind: 'notice'; id: string; text: string; action?: 'continue' }
	| { kind: 'error'; id: string; code: ErrorCode; message: string; retryable: boolean };

export interface SessionTotals {
	promptTokens: number;
	completionTokens: number;
	cost: number;
}

export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	cost: number;
}

export interface SessionView {
	id: string;
	title: string;
	items: TranscriptItem[];
	totals: SessionTotals;
}

export interface ActiveContext {
	/** Workspace-relative path. */
	path: string;
	/** Chip label, e.g. `extension.ts` or `extension.ts:10-24`. */
	label: string;
	hasSelection: boolean;
}

export interface AppState {
	hasApiKey: boolean;
	models: ModelInfo[];
	modelsStale: boolean;
	modelsError?: string;
	selectedModel?: string;
	recentModels: string[];
	mode: Mode;
	autoEdit: boolean;
	running: boolean;
	session: SessionView;
	sessions: SessionSummary[];
	activeContext?: ActiveContext;
	trusted: boolean;
	showOnlyToolModels: boolean;
}

export type ApprovalDecision = 'accept' | 'reject' | 'acceptAll' | 'alwaysAllow';

/** Webview → Extension */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'requestApiKey' }
	| { type: 'clearApiKey' }
	| { type: 'sendMessage'; text: string; includeActiveFile: boolean }
	| { type: 'stop' }
	| { type: 'retry' }
	| { type: 'continue' }
	| { type: 'selectModel'; modelId: string }
	| { type: 'refreshModels' }
	| { type: 'setMode'; mode: Mode }
	| { type: 'setAutoEdit'; value: boolean }
	| { type: 'approval'; callId: string; decision: ApprovalDecision; reason?: string }
	| { type: 'showDiff'; callId: string }
	| { type: 'newChat' }
	| { type: 'loadSession'; id: string }
	| { type: 'deleteSession'; id: string }
	| { type: 'openFile'; path: string; line?: number }
	| { type: 'insertCode'; code: string }
	| { type: 'openExternal'; url: string }
	| { type: 'openSettings' }
	| { type: 'requestTrust' };

/** Events that change the transcript. Applied by `applyTranscriptEvent` on both sides. */
export type TranscriptEvent =
	| { type: 'transcriptAppend'; item: TranscriptItem }
	| { type: 'transcriptRemove'; id: string }
	| { type: 'assistantStart'; messageId: string; model: string; agent?: AgentTag }
	| { type: 'textDelta'; messageId: string; text: string }
	| { type: 'reasoningDelta'; messageId: string; text: string }
	| { type: 'toolCall'; messageId: string; callId: string; name: string; args: unknown; status: ToolStatus }
	| { type: 'toolOutput'; callId: string; chunk: string }
	| { type: 'toolResult'; callId: string; ok: boolean; summary: string; detail?: string; status?: 'done' | 'error' | 'rejected' }
	| { type: 'approvalRequest'; callId: string; kind: ApprovalKind; preview: string; allowPrefix?: string }
	| { type: 'turnDone'; id: string; model: string; usage?: Usage; cost?: number; stopped?: boolean }
	| { type: 'error'; id: string; code: ErrorCode; message: string; retryable: boolean };

/** Extension → Webview */
export type ExtensionMessage =
	| TranscriptEvent
	| { type: 'state'; state: AppState }
	| { type: 'models'; models: ModelInfo[]; stale: boolean; error?: string }
	| { type: 'apiKey'; hasApiKey: boolean }
	| { type: 'selectedModel'; modelId?: string; recentModels: string[] }
	| { type: 'mode'; mode: Mode }
	| { type: 'autoEdit'; value: boolean }
	| { type: 'running'; running: boolean }
	| { type: 'sessions'; sessions: SessionSummary[]; totals: SessionTotals; title: string }
	| { type: 'activeContext'; context?: ActiveContext }
	| { type: 'insertText'; text: string }
	| { type: 'restoreDraft'; text: string }
	| { type: 'trust'; trusted: boolean };

const TRANSCRIPT_EVENT_TYPES = new Set<string>([
	'transcriptAppend', 'transcriptRemove', 'assistantStart', 'textDelta', 'reasoningDelta',
	'toolCall', 'toolOutput', 'toolResult', 'approvalRequest', 'turnDone', 'error',
]);

export function isTranscriptEvent(msg: ExtensionMessage): msg is TranscriptEvent {
	return TRANSCRIPT_EVENT_TYPES.has(msg.type);
}
