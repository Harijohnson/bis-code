import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Settings } from '../config/settings';
import { buildExcludeGlob, workspaceRoots } from '../tools/common';
import { findRipgrep, normalizeRgPath, runRipgrep } from '../tools/grep';
import type { WorkspaceRoot } from '../tools/pathGuard';
import { isDeniedPath } from '../util/glob';
import { renderProjectMap, type MapData, type MapRoot } from '../util/projectTree';

/** Stop listing a folder after this many files. */
const MAX_FILES = 20_000;
/** Size of the map in the system prompt (roughly 2k tokens). */
const PROMPT_CHARS = 8_000;
/** Size of the map opened by "Show Project Map". */
const FULL_CHARS = 500_000;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const FILE_NAME = 'project-map.json';

interface Listing {
	files: string[];
	truncated: boolean;
}

/**
 * Keeps a map of the workspace's files so the agent knows the project layout without listing
 * directories one by one. It is built when a project is opened, saved in the extension's
 * per-workspace storage, and rebuilt before the next agent step whenever files were added or removed.
 */
export class ProjectMap implements vscode.Disposable {
	private data: MapData | undefined;
	private dirty = true;
	private building: Promise<void> | undefined;
	private promptCache: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly storageDir: vscode.Uri | undefined, private readonly settings: Settings) {
		// Content changes don't affect the map; only created and deleted files (renames are both) do.
		const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
		const markDirty = () => {
			this.dirty = true;
		};
		this.disposables.push(
			watcher,
			watcher.onDidCreate(markDirty),
			watcher.onDidDelete(markDirty),
			vscode.workspace.onDidChangeWorkspaceFolders(markDirty),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (Settings.affects(e, 'deniedReadGlobs')) {
					markDirty();
				}
			}),
		);
	}

	/** Loads the saved map so it is available right away, then rebuilds it. A first map is announced in the status bar. */
	async init(): Promise<void> {
		const saved = await this.load();
		if (saved && !this.data) {
			this.setData(saved);
		}
		await this.refresh();
		if (!saved && this.data) {
			const files = this.data.roots.reduce((n, r) => n + r.files.length, 0);
			vscode.window.setStatusBarMessage(`$(list-tree) bis-code mapped this project (${files} files)`, 5000);
		}
	}

	/** Rebuilds the map if files were added or removed since the last build. Never throws. */
	async refresh(): Promise<void> {
		if (!this.building && this.dirty) {
			this.dirty = false;
			this.building = this.build()
				.catch(err => console.error('[bis-code] failed to build the project map', err))
				.finally(() => {
					this.building = undefined;
				});
		}
		await this.building;
	}

	/** Compact map for the system prompt; undefined until the first build, or when no folder is open. */
	promptText(): string | undefined {
		if (this.data && this.promptCache === undefined) {
			this.promptCache = renderProjectMap(this.data, PROMPT_CHARS);
		}
		return this.promptCache;
	}

	/** `bisCode.showProjectMap`: rebuilds the map and opens the full version in an editor. */
	async show(): Promise<void> {
		this.dirty = true;
		await this.refresh();
		if (!this.data) {
			vscode.window.showInformationMessage('bis-code: open a folder to build a project map.');
			return;
		}
		const content = `# Project map\n\n${renderProjectMap(this.data, FULL_CHARS)}\n`;
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	private setData(data: MapData | undefined): void {
		this.data = data;
		this.promptCache = undefined;
	}

	private async build(): Promise<void> {
		const roots = workspaceRoots();
		if (roots.length === 0) {
			this.setData(undefined);
			return;
		}
		const denied = this.settings.deniedReadGlobs;
		const rg = findRipgrep();
		let gitignore = true;
		const mapRoots: MapRoot[] = [];
		for (const root of roots) {
			let listing = rg ? await listWithRipgrep(rg, root) : undefined;
			if (!listing) {
				gitignore = false;
				listing = await listWithFindFiles(root);
			}
			mapRoots.push({
				name: root.name,
				prefix: roots.length > 1 ? `${root.name}/` : '',
				files: listing.files.filter(f => !isDeniedPath(f, denied)),
				truncated: listing.truncated,
				packageJson: isDeniedPath('package.json', denied) ? undefined : await readPackageJson(root),
			});
		}
		this.setData({ generatedAt: Date.now(), gitignore, roots: mapRoots });
		await this.save();
	}

	private get file(): vscode.Uri | undefined {
		return this.storageDir && vscode.Uri.joinPath(this.storageDir, FILE_NAME);
	}

	private async load(): Promise<MapData | undefined> {
		const file = this.file;
		if (!file) {
			return undefined;
		}
		try {
			const data = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as MapData;
			const valid = typeof data?.generatedAt === 'number' && Array.isArray(data.roots)
				&& data.roots.every(r => typeof r?.name === 'string' && typeof r.prefix === 'string' && Array.isArray(r.files));
			return valid ? data : undefined;
		} catch {
			return undefined; // not built yet for this workspace, or unreadable
		}
	}

	private async save(): Promise<void> {
		const file = this.file;
		if (!file || !this.storageDir || !this.data) {
			return;
		}
		try {
			await vscode.workspace.fs.createDirectory(this.storageDir);
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(this.data)));
		} catch (err) {
			console.error('[bis-code] failed to save the project map', err);
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/** Lists files with ripgrep, which honors .gitignore (even outside a git repository). Undefined on failure. */
async function listWithRipgrep(rg: string, root: WorkspaceRoot): Promise<Listing | undefined> {
	const files: string[] = [];
	let truncated = false;
	const args = ['--files', '--hidden', '--no-require-git', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**'];
	const res = await runRipgrep(rg, root.fsPath, args, new AbortController().signal, line => {
		if (line) {
			files.push(normalizeRgPath(line));
		}
		if (files.length >= MAX_FILES) {
			truncated = true;
			return false;
		}
		return true;
	});
	return res.error ? undefined : { files, truncated };
}

async function listWithFindFiles(root: WorkspaceRoot): Promise<Listing> {
	const pattern = new vscode.RelativePattern(vscode.Uri.file(root.fsPath), '**/*');
	const uris = await vscode.workspace.findFiles(pattern, buildExcludeGlob(), MAX_FILES + 1);
	const files = uris.map(u => path.relative(root.fsPath, u.fsPath).split(path.sep).join('/'));
	return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

async function readPackageJson(root: WorkspaceRoot): Promise<string | undefined> {
	const file = path.join(root.fsPath, 'package.json');
	try {
		const stat = await fs.promises.stat(file);
		return stat.size <= MAX_PACKAGE_JSON_BYTES ? await fs.promises.readFile(file, 'utf8') : undefined;
	} catch {
		return undefined;
	}
}
