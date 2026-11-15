import * as vscode from 'vscode';
import { isDeniedPath } from '../util/glob';
import { looksBinary } from '../util/text';
import { displayPath, isGitInternalPath, resolveWorkspacePath, type WorkspaceRoot } from './pathGuard';
import type { ToolContext } from './types';

export interface GuardedPath {
	uri: vscode.Uri;
	absPath: string;
	/** Relative path for the model and UI. */
	display: string;
}

export type Guarded = { ok: true; path: GuardedPath } | { ok: false; error: string };

export function workspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter(f => f.uri.scheme === 'file')
		.map(f => ({ name: f.name, fsPath: f.uri.fsPath }));
}

function guard(input: string, ctx: Pick<ToolContext, 'roots' | 'settings'>, forWrite: boolean): Guarded {
	const resolved = resolveWorkspacePath(input, ctx.roots);
	if (!resolved.ok) {
		return resolved;
	}
	const display = displayPath(resolved, ctx.roots);
	if (forWrite && isGitInternalPath(resolved.relPath)) {
		return { ok: false, error: `Writing inside .git is not allowed: ${display}` };
	}
	if (resolved.relPath !== '.' && isDeniedPath(resolved.relPath, ctx.settings.deniedReadGlobs)) {
		return {
			ok: false,
			error: `Access to ${display} is blocked because it may contain secrets (bisCode.deniedReadGlobs). Ask the user for the specific non-secret values you need instead.`,
		};
	}
	return { ok: true, path: { uri: vscode.Uri.file(resolved.absPath), absPath: resolved.absPath, display } };
}

export function guardRead(input: string, ctx: Pick<ToolContext, 'roots' | 'settings'>): Guarded {
	return guard(input, ctx, false);
}

export function guardWrite(input: string, ctx: Pick<ToolContext, 'roots' | 'settings'>): Guarded {
	return guard(input, ctx, true);
}

/** Key for ReadTracker.readFiles. */
export function fileKey(absPath: string): string {
	const normalized = vscode.Uri.file(absPath).fsPath;
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

export function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
	const key = fileKey(uri.fsPath);
	return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === key);
}

export type TextRead = { ok: true; text: string } | { ok: false; error: string };

/** Reads the open editor's text when the file is open (so unsaved edits are seen), else the file on disk. */
export async function readText(uri: vscode.Uri, display: string): Promise<TextRead> {
	const doc = openDocument(uri);
	if (doc) {
		return { ok: true, text: doc.getText() };
	}
	const bytes = await vscode.workspace.fs.readFile(uri);
	if (looksBinary(bytes)) {
		return { ok: false, error: `${display} looks like a binary file and can't be read as text.` };
	}
	return { ok: true, text: new TextDecoder('utf-8').decode(bytes) };
}

/** Bridges an AbortSignal to a VS Code CancellationToken. */
export function tokenFromSignal(signal: AbortSignal): { token: vscode.CancellationToken; dispose(): void } {
	const cts = new vscode.CancellationTokenSource();
	const onAbort = () => cts.cancel();
	if (signal.aborted) {
		cts.cancel();
	} else {
		signal.addEventListener('abort', onAbort, { once: true });
	}
	return {
		token: cts.token,
		dispose: () => {
			signal.removeEventListener('abort', onAbort);
			cts.dispose();
		},
	};
}

/** `{**\/node_modules/**,...}` built from files.exclude + search.exclude + defaults. */
export function buildExcludeGlob(): string {
	const patterns = new Set<string>(['**/node_modules/**', '**/.git/**']);
	for (const section of ['files', 'search']) {
		const excludes = vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {};
		for (const [pattern, value] of Object.entries(excludes)) {
			if (value === true) {
				patterns.add(pattern);
			}
		}
	}
	return `{${[...patterns].join(',')}}`;
}

/** Checks that a file the agent wants to change was read in this session and hasn't changed on disk since. */
export function checkReadBeforeWrite(ctx: ToolContext, path: GuardedPath, stat: vscode.FileStat): string | undefined {
	const recorded = ctx.session.readFiles[fileKey(path.absPath)];
	if (recorded === undefined) {
		return `You must read ${path.display} with read_file before changing it.`;
	}
	if (stat.mtime !== recorded) {
		return `${path.display} changed on disk since you last read it. Read it again before changing it.`;
	}
	return undefined;
}

export function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
}
