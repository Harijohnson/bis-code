import type { ApprovalDecision, Mode, SubagentKind } from '../shared/protocol';
import type { AnyTool } from '../tools/registry';
import { SUBAGENT_TOOL_NAMES } from '../tools/subagents';

export interface GateOutcome {
	decision: ApprovalDecision;
	reason?: string;
	/** The turn was stopped while waiting. */
	aborted?: boolean;
}

/** Holds approvals that are waiting for the user. Stopping the turn resolves them as aborted. */
export class PermissionGate {
	private readonly pending = new Map<string, (outcome: GateOutcome) => void>();

	wait(callId: string, signal: AbortSignal): Promise<GateOutcome> {
		return new Promise(resolve => {
			if (signal.aborted) {
				resolve({ decision: 'reject', aborted: true });
				return;
			}
			const onAbort = () => {
				this.pending.delete(callId);
				resolve({ decision: 'reject', aborted: true });
			};
			signal.addEventListener('abort', onAbort, { once: true });
			this.pending.set(callId, outcome => {
				signal.removeEventListener('abort', onAbort);
				this.pending.delete(callId);
				resolve(outcome);
			});
		});
	}

	/** Returns false when nothing was waiting for this call (e.g. a stale button click). */
	resolve(callId: string, decision: ApprovalDecision, reason?: string): boolean {
		const resolver = this.pending.get(callId);
		if (!resolver) {
			return false;
		}
		resolver({ decision, reason });
		return true;
	}

	has(callId: string): boolean {
		return this.pending.has(callId);
	}
}

/**
 * Tools the model may use: Agent → all, Plan → read-only, Chat → none. Disallowed tools are never sent
 * to the model. Agent mode keeps edit and command tools in untrusted workspaces: calling one asks the
 * user to trust the workspace first (see AgentLoop.runTool).
 */
export function toolsForMode(mode: Mode, all: AnyTool[]): AnyTool[] {
	if (mode === 'chat') {
		return [];
	}
	return all.filter(t => t.permission === 'auto' || mode === 'agent');
}

/** A sub-agent's tools: explore → read-only, delegate → whatever the mode allows. Never other sub-agents. */
export function toolsForSubagent(kind: SubagentKind, modeTools: AnyTool[]): AnyTool[] {
	return modeTools.filter(t => !SUBAGENT_TOOL_NAMES.has(t.name) && (kind === 'delegate' || t.permission === 'auto'));
}

/** Tools that change the workspace and therefore need a trusted workspace. */
export function needsTrust(tool: AnyTool): boolean {
	return tool.permission === 'edit' || tool.permission === 'command';
}
