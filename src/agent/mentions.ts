import * as vscode from 'vscode';
import type { Settings } from '../config/settings';
import { searchMentions } from '../shared/mentionSearch';
import type { MentionItem } from '../shared/protocol';
import { buildExcludeGlob, fileKey, guardRead, readText, statOrUndefined, workspaceRoots } from '../tools/common';
import { displayPath, resolveWorkspacePath } from '../tools/pathGuard';
import { isDeniedPath } from '../util/glob';
import { truncateEnd } from '../util/text';

const MAX_INDEXED_FILES = 20_000;
const MAX_RESULTS = 50;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_FOLDER_ENTRIES = 200;

/**
 * Workspace files and folders for the @-mention picker. Built lazily from `findFiles`
 * (which honors files.exclude and search.exclude) and rebuilt after files are created or deleted.
 * Paths blocked by `bisCode.deniedReadGlobs` are never offered.
 */
export class MentionIndex implements vscode.Disposable {
	private items: Promise<MentionItem[]> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly settings: Settings) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
		const invalidate = () => (this.items = undefined);
		this.disposables.push(
			watcher,
			watcher.onDidCreate(invalidate),
			watcher.onDidDelete(invalidate),
			vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bisCode.deniedReadGlobs') || e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search.exclude')) {
					invalidate();
				}
			}),
		);
	}

	async search(query: string): Promise<MentionItem[]> {
		this.items ??= this.build().catch(err => {
			this.items = undefined;
			throw err;
		});
		return searchMentions(await this.items, query, MAX_RESULTS, this.openEditorPaths());
	}

	private async build(): Promise<MentionItem[]> {
		const roots = workspaceRoots();
		if (roots.length === 0) {
			return [];
		}
		const denied = this.settings.deniedReadGlobs;
		const uris = await vscode.workspace.findFiles('**/*', buildExcludeGlob(), MAX_INDEXED_FILES);
		const files = new Set<string>();
		const folders = new Set<string>();
		for (const uri of uris) {
			const resolved = resolveWorkspacePath(uri.fsPath, roots);
			if (!resolved.ok || isDeniedPath(resolved.relPath, denied)) {
				continue;
			}
			const shown = displayPath(resolved, roots);
			files.add(shown);
			const parts = shown.split('/');
			for (let i = 1; i < parts.length; i++) {
				folders.add(`${parts.slice(0, i).join('/')}/`);
			}
		}
		return [
			...[...folders].map(path => ({ path, kind: 'folder' as const })),
			...[...files].map(path => ({ path, kind: 'file' as const })),
		];
	}

	/** Open editor tabs as display paths, most recently active first. */
	private openEditorPaths(): string[] {
		const roots = workspaceRoots();
		const out: string[] = [];
		const add = (uri: vscode.Uri | undefined) => {
			if (uri?.scheme !== 'file') {
				return;
			}
			const resolved = resolveWorkspacePath(uri.fsPath, roots);
			if (resolved.ok && !isDeniedPath(resolved.relPath, this.settings.deniedReadGlobs)) {
				const p = displayPath(resolved, roots);
				if (!out.includes(p)) {
					out.push(p);
				}
			}
		};
		add(vscode.window.activeTextEditor?.document.uri);
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					add(tab.input.uri);
				}
			}
		}
		return out;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/**
 * Text appended to the user message for each `@` mention: file contents or a folder listing.
 * Files attached in full are marked as read, so the agent can edit them without reading them again.
 */
export async function buildMentionAttachments(
	paths: string[],
	settings: Settings,
	readFiles: Record<string, number>,
): Promise<string | undefined> {
	const roots = workspaceRoots();
	const parts: string[] = [];
	let budget = MAX_TOTAL_CHARS;
	for (const input of paths) {
		const guarded = guardRead(input.replace(/\/$/, ''), { roots, settings });
		if (!guarded.ok) {
			parts.push(`[@${input}: ${guarded.error}]`);
			continue;
		}
		const { uri, display, absPath } = guarded.path;
		const stat = await statOrUndefined(uri);
		if (!stat) {
			parts.push(`[@${input}: not found]`);
			continue;
		}
		if (stat.type & vscode.FileType.Directory) {
			const listing = await listFolder(uri, display, settings);
			parts.push(listing);
			budget -= listing.length;
			continue;
		}
		if (budget <= 0) {
			parts.push(`[@${display} was not attached because the message is already large. Use read_file to read it.]`);
			continue;
		}
		if (stat.size > MAX_FILE_BYTES) {
			parts.push(`[@${display} is too large to attach (${Math.round(stat.size / 1024)} KB). Use read_file with offset/limit or grep.]`);
			continue;
		}
		const read = await readText(uri, display);
		if (!read.ok) {
			parts.push(`[@${display}: ${read.error}]`);
			continue;
		}
		const cap = Math.min(MAX_FILE_CHARS, budget);
		const truncated = read.text.length > cap;
		const body = truncateEnd(read.text, cap);
		budget -= body.length;
		if (!truncated) {
			readFiles[fileKey(absPath)] = stat.mtime;
		}
		const lang = languageOf(display);
		const note = truncated ? ' (truncated; use read_file with offset/limit for the rest)' : '';
		parts.push(`[Contents of @${display}${note}:]\n\`\`\`${lang}\n${body}\n\`\`\``);
	}
	return parts.length ? parts.join('\n\n') : undefined;
}

async function listFolder(uri: vscode.Uri, display: string, settings: Settings): Promise<string> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return `[@${display}/: could not be listed]`;
	}
	const base = display === '.' ? '' : `${display}/`;
	const lines = entries
		.filter(([name]) => name !== '.git' && !isDeniedPath(`${base}${name}`, settings.deniedReadGlobs))
		.sort(([a, ta], [b, tb]) => (tb & vscode.FileType.Directory) - (ta & vscode.FileType.Directory) || a.localeCompare(b))
		.map(([name, type]) => (type & vscode.FileType.Directory ? `${name}/` : name));
	const shown = lines.slice(0, MAX_FOLDER_ENTRIES);
	const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more` : '';
	return `[Listing of @${base || './'} (${lines.length} entries):]\n${shown.join('\n')}${more}`;
}

const LANGS: Record<string, string> = {
	ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'markdown', py: 'python',
	rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', rb: 'ruby', php: 'php',
	css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell', sql: 'sql',
};

function languageOf(path: string): string {
	const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return LANGS[ext] ?? '';
}
