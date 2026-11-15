import * as vscode from 'vscode';
import { deniedReason, isAllowListed, mentionsDeniedPath } from '../agent/commandPolicy';
import { detectShell, runShellCommand } from '../util/shell';
import { truncateMiddle } from '../util/text';
import { guardRead, statOrUndefined } from './common';
import { errorResult, rejectedResult, type Tool } from './types';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;

interface Args {
	command: string;
	cwd?: string;
	timeout_ms?: number;
}

export const runCommandTool: Tool<Args> = {
	name: 'run_command',
	description:
		"Run a shell command in the user's shell and return its exit code and combined output. " +
		'Run one command at a time. Do not start long-running or interactive processes (dev servers, watch modes, ' +
		'editors, `git rebase -i`); stdin is closed. The user approves each command unless it is allow-listed.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command line to run.' },
			cwd: { type: 'string', description: 'Working directory relative to the workspace root (default: the root).' },
			timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default from settings, max 600000).' },
		},
		required: ['command'],
	},
	permission: 'command',

	async execute(args, ctx) {
		if (!vscode.workspace.isTrusted) {
			return errorResult('Running commands is disabled in untrusted workspaces.');
		}
		const command = args.command.trim();
		if (!command) {
			return errorResult('command is empty.');
		}
		const blocked = deniedReason(command);
		if (blocked) {
			return errorResult(`This command is blocked by bis-code's safety rules (${blocked}). Do not try to work around this.`, `Blocked: ${blocked}`);
		}
		const guarded = guardRead(args.cwd ?? '.', ctx);
		if (!guarded.ok) {
			return errorResult(guarded.error, 'Blocked cwd');
		}
		const stat = await statOrUndefined(guarded.path.uri);
		if (!stat || !(stat.type & vscode.FileType.Directory)) {
			return errorResult(`cwd is not a directory: ${guarded.path.display}`);
		}
		const cwdLabel = guarded.path.display;

		const secret = mentionsDeniedPath(command, ctx.settings.deniedReadGlobs);
		if (secret || !isAllowListed(command, ctx.settings.allowedCommands)) {
			const warning = secret ? 'This command mentions a secret file. Its output would be sent to the model provider.' : undefined;
			const approval = await ctx.approveCommand(command, cwdLabel, warning);
			if (!approval.approved) {
				return rejectedResult('command', approval.reason);
			}
		}

		const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, args.timeout_ms ?? ctx.settings.commandTimeoutMs));
		const shell = detectShell(vscode.env.shell);
		const result = await runShellCommand(shell, command, {
			cwd: guarded.path.absPath,
			timeoutMs,
			signal: ctx.signal,
			onOutput: chunk => ctx.onOutput(chunk),
		});

		const output = truncateMiddle(result.output.trimEnd());
		const shortCmd = command.length > 60 ? command.slice(0, 57) + '…' : command;
		if (result.error) {
			return errorResult(`Failed to start the command: ${result.error}`, `Failed: ${shortCmd}`);
		}
		if (result.aborted) {
			return { ok: false, content: `The user stopped the command.\n${output}`, summary: `Stopped: ${shortCmd}`, status: 'error' };
		}
		if (result.timedOut) {
			return {
				ok: false,
				content: `The command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Avoid long-running commands.\n${output}`,
				summary: `Timed out: ${shortCmd}`,
				status: 'error',
			};
		}
		const code = result.exitCode ?? -1;
		return {
			ok: code === 0,
			content: `Exit code: ${code}\n${output || '(no output)'}`,
			summary: `Ran ${shortCmd} (exit ${code})`,
			status: code === 0 ? 'done' : 'error',
		};
	},
};
