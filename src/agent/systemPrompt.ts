import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Mode } from '../shared/protocol';
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
}

const BASE = `You are bis-code, an AI coding agent running inside the user's VS Code editor. You help with software engineering tasks: explaining code, fixing bugs, adding features, refactoring and running project commands.

# How to work
- Be concise and direct. Answer in GitHub-flavored Markdown. Skip filler and long preambles.
- Investigate before answering: use the tools to look at the actual code instead of guessing. Never invent file contents, APIs or command output.
- Read a file before editing it. Prefer edit_file with a small, unique old_string over rewriting whole files with write_file.
- Make the smallest change that solves the task and match the style of the surrounding code.
- When the request is ambiguous or a decision is genuinely the user's, ask a short clarifying question instead of guessing.
- After changing code, check your work when it is cheap to do so (get_diagnostics, or running the relevant test or build command).
- If a tool call is rejected by the user, do not retry the same call. Adapt or ask.
- Report results honestly: if something failed or you could not verify it, say so.`;

function toolRules(shell: ShellInfo): string {
	return `# Tool rules
- Paths are relative to the workspace root (in multi-root workspaces, prefix the folder name). Only files inside the workspace can be accessed.
- Secret files such as .env and private keys are blocked. Ask the user for the specific non-secret values you need instead.
- Run one command at a time with run_command. Commands run in ${shell.name}, so use its syntax${shell.kind === 'powershell' ? ' (e.g. `;` instead of `&&` in Windows PowerShell 5.1, `Get-ChildItem` or `ls`)' : ''}.
- Avoid long-running or interactive commands: dev servers, watch modes, REPLs, editors, \`git rebase -i\`, prompts that wait for input. stdin is closed.
- Independent read-only lookups can be requested together in one response; they run in parallel.`;
}

function modeNote(mode: Mode, trusted: boolean): string {
	if (mode === 'plan') {
		return '# Mode: Plan\nYou can only read and search; you cannot edit files or run commands. Investigate, then answer or propose a concrete step-by-step plan (files to change and how). Do not claim to have made changes.';
	}
	if (mode === 'chat') {
		return '# Mode: Chat\nNo tools are available. Answer from the conversation and the editor context below. If you need to see a file, ask the user to paste it or to switch to Agent mode.';
	}
	if (!trusted) {
		return '# Mode: Agent (restricted)\nThis workspace is not trusted, so file edits and commands are disabled. You can read and search.';
	}
	return '# Mode: Agent\nYou can read, search, edit files and run commands. The user approves edits and commands unless they enabled auto-approval.';
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

/** Built fresh for every request so the editor context is current. */
export function buildSystemPrompt(inputs: PromptInputs): string {
	return [
		BASE,
		modeNote(inputs.mode, inputs.trusted),
		inputs.toolNames.length ? toolRules(inputs.shell) : undefined,
		environment(inputs),
		editorContext(inputs),
		projectInstructions(inputs.roots),
	].filter(Boolean).join('\n\n');
}
