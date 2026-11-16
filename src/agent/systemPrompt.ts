import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Mode, SubagentKind } from '../shared/protocol';
import { isInside, type WorkspaceRoot } from '../tools/pathGuard';
import { isDeniedPath } from '../util/glob';
import type { ShellInfo } from '../util/shell';
import { truncateEnd } from '../util/text';

/** Project instruction files, read from each workspace root (both are supported). */
export const INSTRUCTION_FILES = ['AGENTS.md', 'BIS.md'];
const MAX_INSTRUCTIONS_CHARS = 20_000;
const MAX_SELECTION_CHARS = 2_000;
const MAX_TABS = 20;

export interface PromptInputs {
	mode: Mode;
	trusted: boolean;
	roots: WorkspaceRoot[];
	shell: ShellInfo;
	editor: vscode.TextEditor | undefined;
	toolNames: string[];
	/** Secret-file globs: such files are never described or quoted in the prompt. */
	deniedGlobs: string[];
	/** Compact map of the workspace's files, included when tools are available. */
	projectMap?: string;
	/** Set when the prompt is for a sub-agent rather than the main agent. */
	subagent?: SubagentKind;
}

const IDENTITY = `You are bis-code, an AI coding agent running inside the user's VS Code editor. You help with software engineering tasks: explaining code, fixing bugs, building features, refactoring and running project commands.`;

const STANDARD = `# Engineering standard
Work like a principal engineer who owns the result. Understand the problem and the existing code before changing anything, choose the simplest design that fully solves it, and check every corner before calling it done:
- Trace the impact of a change: find every caller, import, config entry and test it touches, and update them together.
- Handle edge cases: empty or missing values, error and failure paths, concurrency and ordering, large inputs, Windows and POSIX paths, and security (injection, secrets, path traversal).
- Follow the project's existing patterns, naming, error handling and style. Don't add dependencies, abstractions or features nobody asked for.
- Verify your work: after changing code, check diagnostics and run the relevant type-check, lint, build or tests when they exist. Fix what you broke.
- Before you finish, review your own changes like a strict code reviewer: correctness, leftovers (debug code, TODOs, unused code) and consistency.`;

const ACCURACY = `# Accuracy: never guess
- Base every statement about the code on something you saw in this session: a file, a search result or command output. Cite it as path:line when it helps.
- Never invent file paths, functions, APIs, settings, package names or versions, command output or test results. If you haven't checked something, check it, or say clearly that it is unverified.
- Before using a library API, confirm it exists in the version this project uses (search the code, the manifest or the installed type definitions).
- If a search finds nothing, say so and try another approach. Don't fill gaps with assumptions.
- Never claim that something works, passes or is fixed unless you verified it. Report failures, skipped steps and open risks honestly.`;

const ASKING = `# When to ask
- If the request is ambiguous and the answer changes what you would build (unclear requirements or expected behavior, several plausible targets, a product or design decision, anything destructive or hard to undo), ask before acting. Don't assume.
- Ask only what is necessary: one short message with the fewest questions that unblock you (usually 1-3), each with concrete options or your recommended default.
- Don't ask what you can find out with your tools or what has an obvious conventional answer. Once the user answers, proceed without asking again.`;

const STYLE = `# How to work
- Be concise and direct. Answer in GitHub-flavored Markdown. Skip filler and long preambles.
- Make the smallest complete change that solves the task.
- If the user rejects a tool call, do not retry the same call. Adapt or ask.`;

function toolRules(inputs: PromptInputs): string {
	const can = (name: string) => inputs.toolNames.includes(name);
	const { shell } = inputs;
	const start = [inputs.projectMap && 'the project map', !inputs.subagent && 'the editor context'].filter(Boolean).join(' and ');
	const finding = [
		'# Finding code',
		'Locate before you read. Never read a whole project, or every file in a folder, to find something.',
		start ? `- Start from ${start} below.` : undefined,
		'- Use grep with a precise regular expression (a function, class or variable name, an import, an error message, a config key) to find the exact files and lines. Narrow it with path or glob, use context_lines to see the surrounding code, and files_only to just list where something appears.',
		'- Use glob to find files by name.',
		'- Then read only what you need: for large files, read the relevant range with offset/limit instead of the whole file.',
		'- Request independent searches and reads together in one response; they run in parallel.',
	];
	const rules = [
		'# Tool rules',
		'- Paths are relative to the workspace root (in multi-root workspaces, prefix the folder name). Only files inside the workspace can be accessed.',
		can('edit_file') ? '- Read a file before editing it. Prefer edit_file with a small, unique old_string over rewriting whole files with write_file.' : undefined,
		'- Secret files such as .env and private keys are blocked. Ask the user for the specific non-secret values you need instead.',
	];
	if (can('run_command')) {
		rules.push(
			`- Run one command at a time with run_command. Commands run in ${shell.name}, so use its syntax${shell.kind === 'powershell' ? ' (e.g. `;` instead of `&&` in Windows PowerShell 5.1, `Get-ChildItem` or `ls`)' : ''}.`,
			'- Avoid long-running or interactive commands: dev servers, watch modes, REPLs, editors, `git rebase -i`, prompts that wait for input. stdin is closed.',
		);
	}
	return [...finding, '', ...rules].filter(line => line !== undefined).join('\n');
}

function subagentGuide(toolNames: string[]): string {
	return [
		'# Sub-agents',
		'For substantial work, split it up instead of doing everything yourself in one long thread. You stay the lead: plan, split the work, then integrate and verify the results.',
		'- explore: read-only sub-agents that each research one question and report back. Launch several in one response to investigate independent questions in parallel; this also keeps bulky searching out of your context.',
		toolNames.includes('delegate')
			? '- delegate: a sub-agent that implements one well-scoped, independent part of a feature (for example "add the endpoint" or "write tests for X"). Delegates run one at a time.'
			: undefined,
		"- Sub-agents can't see this conversation. Give each a self-contained brief: the goal, paths and symbols you already know, constraints and conventions, and what to report.",
		'- Treat reports as leads, not facts: check the key claims and review changed code (read it, run checks) before relying on them or telling the user the work is done.',
		'- Use agent_id to send a sub-agent follow-up questions or fixes; it keeps its context.',
		"- Don't hand off trivial work such as one search or a small edit; do it yourself.",
	].filter(Boolean).join('\n');
}

const RESTRICTED_NOTE =
	"This workspace isn't trusted yet. Reading and searching work normally. When you call edit_file, write_file or run_command, " +
	'bis-code first asks the user to trust the workspace. If they decline, the call fails: continue read-only and describe the changes instead of retrying.';

function modeNote(mode: Mode, trusted: boolean): string {
	if (mode === 'plan') {
		return '# Mode: Plan\nYou can only read and search; you cannot edit files or run commands. Investigate, then answer or propose a concrete step-by-step plan (files to change and how). Do not claim to have made changes.';
	}
	if (mode === 'chat') {
		return '# Mode: Chat\nNo tools are available. Answer from the conversation and the editor context below. If you need to see a file, ask the user to paste it or to switch to Agent mode.';
	}
	if (!trusted) {
		return `# Mode: Agent (Restricted Mode)\n${RESTRICTED_NOTE}`;
	}
	return '# Mode: Agent\nYou can read, search, edit files and run commands. The user approves edits and commands unless they enabled auto-approval.';
}

function subagentRole(kind: SubagentKind, trusted: boolean): string {
	if (kind === 'explore') {
		return `# Role: explore sub-agent
The main bis-code agent started you to research one question. You can search and read, not edit. Only the main agent reads your final reply; the user can't answer questions.
- Search in a targeted way and stop as soon as you can answer well.
- Your final reply is your report: lead with the answer, then the evidence as path:line references with short quotes or summaries, then anything you couldn't determine. Keep it concise and factual, and mark anything unverified.`;
	}
	return `# Role: delegate sub-agent
The main bis-code agent started you to complete one well-scoped task. You can search, read, edit files and run commands; the user approves edits and commands. Only the main agent reads your final reply; the user can't answer questions.
- Stay within the task. If it is blocked, or ambiguous in a way that changes the result, stop and explain what you need instead of guessing.
- Your final reply is your report: what you changed (files and why), how you verified it (commands and their results), and anything left open or risky.${trusted ? '' : `\n- ${RESTRICTED_NOTE}`}`;
}

function environment(inputs: PromptInputs): string {
	const roots = inputs.roots.length
		? inputs.roots.map(r => {
			const git = fs.existsSync(path.join(r.fsPath, '.git')) ? ' (git repository)' : '';
			return `  - ${r.name}: ${r.fsPath}${git}`;
		}).join('\n')
		: '  - (no folder open: file tools are unavailable)';
	return `# Environment
- OS: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform} (${process.platform})
- Shell: ${inputs.shell.name} (${inputs.shell.path})
- Today's date: ${new Date().toLocaleDateString('en-CA')}
- Workspace folders:
${roots}`;
}

/** Workspace-relative path, or undefined for files outside the workspace or matching a secret glob. */
function relative(uri: vscode.Uri, inputs: PromptInputs): string | undefined {
	if (uri.scheme !== 'file') {
		return undefined;
	}
	const root = inputs.roots.find(r => isInside(r.fsPath, uri.fsPath));
	if (!root) {
		return undefined;
	}
	const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
	if (isDeniedPath(rel, inputs.deniedGlobs)) {
		return undefined;
	}
	return inputs.roots.length > 1 ? `${root.name}/${rel}` : rel;
}

function editorContext(inputs: PromptInputs): string | undefined {
	const lines: string[] = [];
	const editor = inputs.editor;
	const active = editor ? relative(editor.document.uri, inputs) : undefined;
	if (editor && active) {
		const sel = editor.selection;
		lines.push(`- Active file: ${active} (cursor at line ${sel.active.line + 1})`);
		if (!sel.isEmpty) {
			const text = editor.document.getText(sel);
			lines.push(`- Selected lines ${sel.start.line + 1}-${sel.end.line + 1}:\n\`\`\`\n${truncateEnd(text, MAX_SELECTION_CHARS)}\n\`\`\``);
		}
	}
	const tabs = vscode.window.tabGroups.all
		.flatMap(g => g.tabs)
		.map(t => (t.input instanceof vscode.TabInputText ? relative(t.input.uri, inputs) : undefined))
		.filter((p): p is string => !!p && p !== active);
	const unique = [...new Set(tabs)].slice(0, MAX_TABS);
	if (unique.length) {
		lines.push(`- Other open tabs: ${unique.join(', ')}`);
	}
	return lines.length ? `# Editor context\n${lines.join('\n')}` : undefined;
}

function projectInstructions(roots: WorkspaceRoot[]): string | undefined {
	const blocks: string[] = [];
	for (const root of roots) {
		for (const name of INSTRUCTION_FILES) {
			const file = path.join(root.fsPath, name);
			try {
				const text = fs.readFileSync(file, 'utf8').trim();
				if (text) {
					const label = roots.length > 1 ? `${root.name}/${name}` : name;
					blocks.push(`## ${label}\n${truncateEnd(text, MAX_INSTRUCTIONS_CHARS)}`);
				}
			} catch {
				// not present
			}
		}
	}
	return blocks.length
		? `# Project instructions\nThe project provides these instructions. Follow them unless the user says otherwise.\n\n${blocks.join('\n\n')}`
		: undefined;
}

/** Built fresh for every request so the editor context and project map are current. */
export function buildSystemPrompt(inputs: PromptInputs): string {
	const hasTools = inputs.toolNames.length > 0;
	return [
		IDENTITY,
		STANDARD,
		ACCURACY,
		// Sub-agents can't reach the user; their role note says to report blockers instead.
		inputs.subagent ? undefined : ASKING,
		STYLE,
		inputs.subagent ? subagentRole(inputs.subagent, inputs.trusted) : modeNote(inputs.mode, inputs.trusted),
		hasTools ? toolRules(inputs) : undefined,
		inputs.toolNames.includes('explore') ? subagentGuide(inputs.toolNames) : undefined,
		environment(inputs),
		hasTools && inputs.projectMap ? `# Project map\n${inputs.projectMap}` : undefined,
		inputs.subagent ? undefined : editorContext(inputs),
		projectInstructions(inputs.roots),
	].filter(Boolean).join('\n\n');
}
