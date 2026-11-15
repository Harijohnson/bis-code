import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isDeniedPath } from '../util/glob';
import { looksBinary } from '../util/text';
import { buildExcludeGlob, guardRead, tokenFromSignal } from './common';
import { isInside, type WorkspaceRoot } from './pathGuard';
import { errorResult, type Tool, type ToolContext } from './types';

const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 300;
const JS_MAX_FILES = 5000;
const JS_MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Args {
	pattern: string;
	path?: string;
	glob?: string;
	case_insensitive?: boolean;
}

interface Match {
	/** Display path (relative, `/`-separated). */
	file: string;
	line: number;
	text: string;
}

interface SearchResult {
	matches: Match[];
	truncated: boolean;
	error?: string;
}

let ripgrepPath: string | null | undefined;

/** VS Code ships ripgrep; probe the known locations once. */
export function findRipgrep(): string | undefined {
	if (ripgrepPath === undefined) {
		const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
		const root = vscode.env.appRoot;
		const candidates = [
			path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
			path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
			path.join(root, 'node_modules', 'vscode-ripgrep', 'bin', exe),
			path.join(root, 'node_modules.asar.unpacked', 'vscode-ripgrep', 'bin', exe),
		];
		ripgrepPath = candidates.find(p => fs.existsSync(p)) ?? null;
	}
	return ripgrepPath ?? undefined;
}

function normalizeRgPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function runRipgrep(rg: string, cwd: string, args: string[], prefix: string, signal: AbortSignal, max: number): Promise<SearchResult> {
	return new Promise(resolve => {
		const child = spawn(rg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const matches: Match[] = [];
		let truncated = false;
		let buffer = '';
		let stderr = '';
		const onAbort = () => child.kill();
		signal.addEventListener('abort', onAbort, { once: true });

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (data: string) => {
			if (truncated) {
				return;
			}
			buffer += data;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				const nul = line.indexOf('\0');
				if (nul < 0) {
					continue;
				}
				const rest = line.slice(nul + 1);
				const colon = rest.indexOf(':');
				const lineNo = Number(rest.slice(0, colon));
				if (colon < 0 || !Number.isFinite(lineNo)) {
					continue;
				}
				matches.push({ file: prefix + normalizeRgPath(line.slice(0, nul)), line: lineNo, text: rest.slice(colon + 1) });
				if (matches.length >= max) {
					truncated = true;
					child.kill();
					return;
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (d: string) => {
			stderr += d;
		});
		child.on('error', err => {
			signal.removeEventListener('abort', onAbort);
			resolve({ matches, truncated, error: err.message });
		});
		child.on('close', code => {
			signal.removeEventListener('abort', onAbort);
			// rg exits 1 for "no matches" and 2 for errors (possibly with partial results).
			resolve({ matches, truncated, error: code === 2 && matches.length === 0 ? stderr.trim() || 'ripgrep failed' : undefined });
		});
	});
}

async function searchWithRipgrep(rg: string, args: Args, ctx: ToolContext, targets: { root: WorkspaceRoot; rel?: string; prefix: string }[]): Promise<SearchResult> {
	const base = [
		'--line-number', '--no-heading', '--with-filename', '--null', '--color', 'never',
		'--hidden', '--max-columns', String(MAX_LINE_CHARS), '--max-columns-preview', '--max-filesize', '2M',
		args.case_insensitive ? '--ignore-case' : '--case-sensitive',
		'--glob', '!**/node_modules/**', '--glob', '!**/.git/**',
	];
	for (const g of ctx.settings.deniedReadGlobs) {
		if (!g.startsWith('!')) {
			base.push('--glob', `!${g}`);
		}
	}
	if (args.glob) {
		base.push('--glob', args.glob);
	}
	base.push('--regexp', args.pattern);

	const all: Match[] = [];
	let truncated = false;
	for (const t of targets) {
		const res = await runRipgrep(rg, t.root.fsPath, t.rel ? [...base, '--', t.rel] : base, t.prefix, ctx.signal, MAX_MATCHES - all.length);
		if (res.error) {
			return { matches: all, truncated, error: res.error };
		}
		all.push(...res.matches);
		if (res.truncated || all.length >= MAX_MATCHES) {
			truncated = true;
			break;
		}
	}
	return { matches: all, truncated };
}

async function searchWithJs(regex: RegExp, args: Args, ctx: ToolContext, base: vscode.Uri | undefined): Promise<SearchResult> {
	const pattern = args.glob ?? '**/*';
	const include: vscode.GlobPattern = base ? new vscode.RelativePattern(base, pattern) : pattern;
	const cancel = tokenFromSignal(ctx.signal);
	let uris: vscode.Uri[];
	try {
		uris = await vscode.workspace.findFiles(include, buildExcludeGlob(), JS_MAX_FILES, cancel.token);
	} finally {
		cancel.dispose();
	}
	const multiRoot = ctx.roots.length > 1;
	const matches: Match[] = [];
	for (const uri of uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
		if (ctx.signal.aborted) {
			break;
		}
		const root = ctx.roots.find(r => isInside(r.fsPath, uri.fsPath));
		const rel = root ? path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/') : uri.fsPath;
		if (isDeniedPath(rel, ctx.settings.deniedReadGlobs)) {
			continue;
		}
		let bytes: Uint8Array;
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > JS_MAX_FILE_BYTES) {
				continue;
			}
			bytes = await vscode.workspace.fs.readFile(uri);
		} catch {
			continue;
		}
		if (looksBinary(bytes)) {
			continue;
		}
		const lines = new TextDecoder('utf-8').decode(bytes).split(/\r?\n/);
		const display = vscode.workspace.asRelativePath(uri, multiRoot);
		for (let i = 0; i < lines.length; i++) {
			regex.lastIndex = 0;
			if (regex.test(lines[i])) {
				matches.push({ file: display, line: i + 1, text: lines[i] });
				if (matches.length >= MAX_MATCHES) {
					return { matches, truncated: true };
				}
			}
		}
	}
	return { matches, truncated: false };
}

export const grepTool: Tool<Args> = {
	name: 'grep',
	description:
		'Search file contents with a regular expression (ripgrep syntax). Returns "path:line: text" lines, ' +
		`up to ${MAX_MATCHES} matches. Respects .gitignore and skips node_modules and secret files. ` +
		'Use glob to limit file types, e.g. "*.ts".',
	parameters: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Regular expression to search for.' },
			path: { type: 'string', description: 'File or directory to search, relative to the workspace root. Defaults to the whole workspace.' },
			glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".' },
			case_insensitive: { type: 'boolean', description: 'Ignore case (default false).' },
		},
		required: ['pattern'],
	},
	permission: 'auto',

	async execute(args, ctx) {
		if (ctx.roots.length === 0) {
			return errorResult('No workspace folder is open.');
		}
		let regex: RegExp;
		try {
			regex = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
		} catch (err) {
			return errorResult(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, 'Invalid pattern');
		}

		let base: vscode.Uri | undefined;
		let targets: { root: WorkspaceRoot; rel?: string; prefix: string }[];
		const multiRoot = ctx.roots.length > 1;
		if (args.path && args.path !== '.') {
			const guarded = guardRead(args.path, ctx);
			if (!guarded.ok) {
				return errorResult(guarded.error, 'Blocked');
			}
			base = guarded.path.uri;
			const root = ctx.roots.find(r => isInside(r.fsPath, guarded.path.absPath))!;
			targets = [{ root, rel: path.relative(root.fsPath, guarded.path.absPath) || undefined, prefix: multiRoot ? `${root.name}/` : '' }];
		} else {
			targets = ctx.roots.map(root => ({ root, prefix: multiRoot ? `${root.name}/` : '' }));
		}

		const rg = findRipgrep();
		let result = rg ? await searchWithRipgrep(rg, args, ctx, targets) : undefined;
		if (!result || (result.error && result.matches.length === 0 && /spawn|ENOENT|EACCES/i.test(result.error))) {
			result = await searchWithJs(regex, args, ctx, base);
		}
		if (result.error) {
			return errorResult(`Search failed: ${result.error}`, 'Search failed');
		}

		const matches = result.matches.filter(m => !isDeniedPath(m.file, ctx.settings.deniedReadGlobs));
		if (matches.length === 0) {
			return { ok: true, content: `No matches for /${args.pattern}/.`, summary: `Searched "${args.pattern}" (no matches)` };
		}
		const files = new Set(matches.map(m => m.file)).size;
		const lines = matches.map(m => {
			const text = m.text.length > MAX_LINE_CHARS ? m.text.slice(0, MAX_LINE_CHARS) + '…' : m.text;
			return `${m.file}:${m.line}: ${text}`;
		});
		const note = result.truncated ? `\n[Stopped at ${MAX_MATCHES} matches; narrow the pattern, path or glob.]` : '';
		return {
			ok: true,
			content: lines.join('\n') + note,
			summary: `Searched "${args.pattern}" (${matches.length}${result.truncated ? '+' : ''} matches in ${files} file${files === 1 ? '' : 's'})`,
		};
	},
};
