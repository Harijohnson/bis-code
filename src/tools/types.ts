import type * as vscode from 'vscode';
import type { Settings } from '../config/settings';
import type { JsonSchema } from '../openrouter/types';
import type { WorkspaceRoot } from './pathGuard';

/** auto: runs without asking. edit: diff + approval (unless Auto-edit). command: approval unless allow-listed. */
export type ToolPermission = 'auto' | 'edit' | 'command';

export interface ToolResult {
	ok: boolean;
	/** Sent to the model as the tool message. */
	content: string;
	/** One line for the tool card, e.g. `Read src/extension.ts (120 lines)`. */
	summary: string;
	/** Extra text shown when the card is expanded. */
	detail?: string;
	status?: 'done' | 'error' | 'rejected';
}

export interface ApprovalOutcome {
	approved: boolean;
	reason?: string;
}

/** Per-session file read tracking: normalized absolute path → mtime at read time. */
export interface ReadTracker {
	readFiles: Record<string, number>;
}

export interface ToolContext {
	callId: string;
	session: ReadTracker;
	signal: AbortSignal;
	roots: WorkspaceRoot[];
	settings: Settings;
	/** Streams text into the tool card (run_command). */
	onOutput(chunk: string): void;
	/** Shows a diff and waits for Accept/Reject (returns approved right away in Auto-edit). */
	approveEdit(file: vscode.Uri, original: string | undefined, proposed: string, preview: string): Promise<ApprovalOutcome>;
	/** Shows the command (and an optional warning) and waits for Run/Reject. */
	approveCommand(command: string, cwdLabel: string, warning?: string): Promise<ApprovalOutcome>;
}

export interface Tool<A = Record<string, unknown>> {
	name: string;
	description: string;
	parameters: JsonSchema;
	permission: ToolPermission;
	execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export function errorResult(message: string, summary = message): ToolResult {
	return { ok: false, content: `Error: ${message}`, summary, status: 'error' };
}

export function rejectedResult(what: string, reason?: string): ToolResult {
	const why = reason?.trim() ? ` Reason: ${reason.trim()}` : '';
	return {
		ok: false,
		content: `The user rejected this ${what}.${why} Do not retry the same ${what}; adjust your approach or ask the user.`,
		summary: `Rejected${why ? ` — ${reason!.trim()}` : ''}`,
		status: 'rejected',
	};
}

/** Light JSON-schema check: required fields and primitive types. Returns an error message or undefined. */
export function validateArgs(schema: JsonSchema, args: unknown): string | undefined {
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return 'arguments must be a JSON object';
	}
	const obj = args as Record<string, unknown>;
	for (const key of schema.required ?? []) {
		if (obj[key] === undefined || obj[key] === null) {
			return `missing required argument "${key}"`;
		}
	}
	for (const [key, value] of Object.entries(obj)) {
		const prop = schema.properties[key];
		if (!prop || value === undefined || value === null) {
			continue;
		}
		const type = prop.type;
		const actual = Array.isArray(value) ? 'array' : typeof value;
		const ok = type === 'integer' ? Number.isInteger(value) : type === actual;
		if (!ok) {
			return `argument "${key}" must be ${type === 'integer' ? 'an integer' : `a ${type}`}, got ${actual}`;
		}
	}
	return undefined;
}
