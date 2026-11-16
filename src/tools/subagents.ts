import type { SubagentKind } from '../shared/protocol';
import { errorResult, type Tool, type ToolPermission } from './types';

interface Args {
	description: string;
	prompt: string;
	agent_id?: string;
}

/** Sub-agents never get these tools, so they can't start sub-agents of their own. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set<SubagentKind>(['explore', 'delegate']);

function subagentTool(name: SubagentKind, permission: ToolPermission, description: string): Tool<Args> {
	return {
		name,
		description,
		parameters: {
			type: 'object',
			properties: {
				description: { type: 'string', description: 'Short label for the task (3-6 words), shown to the user.' },
				prompt: {
					type: 'string',
					description: 'Complete, self-contained brief: the goal, what you already know (paths, symbols, findings), constraints and conventions, and exactly what to report back.',
				},
				agent_id: { type: 'string', description: 'agent_id from an earlier report, to send that sub-agent a follow-up instead of starting a new one. It keeps its context.' },
			},
			required: ['description', 'prompt'],
		},
		permission,

		async execute(args, ctx) {
			if (!ctx.runSubagent) {
				return errorResult('Sub-agents cannot start other sub-agents. Do this work yourself.', 'Not available');
			}
			if (!args.prompt.trim()) {
				return errorResult('prompt must not be empty.', 'Empty prompt');
			}
			return ctx.runSubagent({
				kind: name,
				description: args.description.trim(),
				prompt: args.prompt,
				agentId: args.agent_id?.trim() || undefined,
			});
		},
	};
}

export const exploreTool = subagentTool('explore', 'auto',
	'Start a read-only sub-agent that investigates one question in the codebase (it can search and read, not edit) ' +
	'and returns a concise report with path:line references. It starts with a fresh context and cannot see this conversation, ' +
	'so the prompt must be self-contained. Several explore calls in one response run at the same time, so use it to research ' +
	'independent questions in parallel or to keep large searches out of your own context. ' +
	'Do not use it for a single search or read you could do directly.');

export const delegateTool = subagentTool('delegate', 'delegate',
	'Start a sub-agent with full tool access (search, read, edit files, run commands; the user still approves edits and commands) ' +
	'to complete one well-scoped, independent part of a larger task, then report what it changed and how it verified it. ' +
	'It starts with a fresh context and cannot see this conversation, so give a complete brief: goal, relevant files, ' +
	'constraints and conventions, and how to verify. Delegates run one at a time. ' +
	'Review its report and the changed code before relying on it.');
