import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isDeniedPath } from '../util/glob';
import { looksBinary, pluralize } from '../util/text';
import { buildExcludeGlob, guardRead, statOrUndefined, tokenFromSignal } from './common';
import { isInside, type WorkspaceRoot } from './pathGuard';
import { errorResult, type Tool, type ToolContext } from './types';

const MAX_MATCHES = 200;
/** Each match brings up to 2×context_lines extra lines, so fewer matches are kept with context. */
const MAX_CONTEXT_MATCHES = 50;
const MAX_CONTEXT_LINES = 10;
const MAX_LINE_CHARS = 300;
const JS_MAX_FILES = 5000;
const JS_MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Args {
	pattern: string;
	path?: string;
	glob?: string;
	case_insensitive?: boolean;
	context_lines?: number;
	files_only?: boolean;
}

interface Line {
	/** Display path (relative, `/`-separated). */
	file: string;
	line: number;
	text: string;
	/** False for context lines around a match. */
	match: boolean;
}

interface SearchOptions {
	context: number;
	filesOnly: boolean;
	/** Maximum matches, or files in files_only mode. */
	limit: number;
}

interface SearchResult {
	/** Matches and their context lines in file order; one entry per file in files_only mode. */
	lines: Line[];
	truncated: boolean;
	error?: string;
}

interface Target {
	root: WorkspaceRoot;
	rel?: string;
	prefix: string;
}

let ripgrepPath: string | null | undefined;

/** VS Code ships ripgrep; probe the known locations once. */
export function findRipgrep(): string | undefined {
	if (ripgrepPath === undefined) {
		const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
		const root = vscode.env.appRoot;
		const platformDir = `${process.platform}-${process.arch}`;
		const candidates = [
			// Newer VS Code builds ship per-platform binaries in @vscode/ripgrep-universal.
			path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', platformDir, exe),
			path.join(root, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', platformDir, exe),
			path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
			path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
			path.join(root, 'node_modules', 'vscode-ripgrep', 'bin', exe),
			path.join(root, 'node_modules.asar.unpacked', 'vscode-ripgrep', 'bin', exe),
		];
		ripgrepPath = candidates.find(p => fs.existsSync(p)) ?? null;
	}
	return ripgrepPath ?? undefined;
}

export function normalizeRgPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Runs ripgrep and passes each stdout line to `onLine`, which returns false to stop early.
 * rg exits 1 for "no matches" and 2 for errors (possibly with partial output).
 */
export function runRipgrep(
	rg: string, cwd: string, args: string[], signal: AbortSignal, onLine: (line: string) => boolean,
): Promise<{ error?: string }> {
	return new Promise(resolve => {
		const child = spawn(rg, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let stopped = false;
		let produced = false;
		let buffer = '';
		let stderr = '';
		const onAbort = () => child.kill();
		signal.addEventListener('abort', onAbort, { once: true });

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (data: string) => {
			if (stopped) {
				return;
			}
			buffer += data;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, '');
				buffer = buffer.slice(nl + 1);
				produced = true;
				if (!onLine(line)) {
					stopped = true;
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
			resolve({ error: err.message });
		});
		child.on('close', code => {
			signal.removeEventListener('abort', onAbort);
			resolve({ error: code === 2 && !produced ? stderr.trim() || 'ripgrep failed' : undefined });
		});
	});
}

/** Parses `path\0line:text` (match) or `path\0line-text` (context) from `rg --null`. Group separators return undefined. */
function parseRgLine(raw: string, prefix: string): Line | undefined {
	const nul = raw.indexOf('\0');
	if (nul < 0) {
		return undefined;
	}
	const rest = raw.slice(nul + 1);
	const m = /^(\d+)([:-])/.exec(rest);
	if (!m) {
		return undefined;
	}
	return { file: prefix + normalizeRgPath(raw.slice(0, nul)), line: Number(m[1]), text: rest.slice(m[0].length), match: m[2] === ':' };
}

async function searchWithRipgrep(rg: string, args: Args, opts: SearchOptions, ctx: ToolContext, targets: Target[]): Promise<SearchResult> {
	const base = [
		'--color', 'never', '--hidden', '--max-filesize', '2M',
		args.case_insensitive ? '--ignore-case' : '--case-sensitive',
		'--glob', '!**/node_modules/**', '--glob', '!**/.git/**',
	];
	if (opts.filesOnly) {
		base.push('--files-with-matches');
	} else {
		base.push('--line-number', '--no-heading', '--with-filename', '--null', '--max-columns', String(MAX_LINE_CHARS), '--max-columns-preview');
		if (opts.context) {
			base.push('--context', String(opts.context));
		}
	}
	for (const g of ctx.settings.deniedReadGlobs) {
		if (!g.startsWith('!')) {
			base.push('--glob', `!${g}`);
		}
	}
	if (args.glob) {
		base.push('--glob', args.glob);
	}
	base.push('--regexp', args.pattern);

	const lines: Line[] = [];
	let matches = 0;
	let full = false;
	for (const t of targets) {
		const res = await runRipgrep(rg, t.root.fsPath, t.rel ? [...base, '--', t.rel] : base, ctx.signal, raw => {
			const line = opts.filesOnly
				? (raw ? { file: t.prefix + normalizeRgPath(raw), line: 0, text: '', match: true } : undefined)
				: parseRgLine(raw, t.prefix);
			if (full) {
				// The limit is reached: keep only the trailing context of the last match.
				const prev = lines[lines.length - 1];
				if (!line || line.match || line.file !== prev.file || line.line !== prev.line + 1) {
					return false;
				}
				lines.push(line);
				return true;
			}
			if (!line) {
				return true;
			}
			lines.push(line);
			if (line.match && ++matches >= opts.limit) {
				full = true;
				return opts.context > 0;
			}
			return true;
		});
		if (res.error) {
			return { lines, truncated: full, error: res.error };
		}
		if (full) {
			break;
		}
	}
	return { lines, truncated: full };
}

async function searchWithJs(regex: RegExp, args: Args, opts: SearchOptions, ctx: ToolContext, base: vscode.Uri | undefined): Promise<SearchResult> {
	let uris: vscode.Uri[];
	const baseStat = base && await statOrUndefined(base);
	if (base && baseStat && !(baseStat.type & vscode.FileType.Directory)) {
		// A single file: findFiles needs a folder as its base.
		uris = [base];
	} else {
		const pattern = args.glob ?? '**/*';
		const include: vscode.GlobPattern = base ? new vscode.RelativePattern(base, pattern) : pattern;
		const cancel = tokenFromSignal(ctx.signal);
		try {
			uris = await vscode.workspace.findFiles(include, buildExcludeGlob(), JS_MAX_FILES, cancel.token);
		} finally {
			cancel.dispose();
		}
	}
	const multiRoot = ctx.roots.length > 1;
	const out: Line[] = [];
	let matches = 0;
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
		const hits: number[] = [];
		for (let i = 0; i < lines.length && matches + hits.length < opts.limit; i++) {
			regex.lastIndex = 0;
			if (regex.test(lines[i])) {
				hits.push(i);
				if (opts.filesOnly) {
					break;
				}
			}
		}
		if (hits.length === 0) {
			continue;
		}
		if (opts.filesOnly) {
			out.push({ file: display, line: 0, text: '', match: true });
		} else {
			const isHit = new Set(hits);
			let next = 0; // first line not emitted yet, so overlapping context isn't repeated
			for (const h of hits) {
				const to = Math.min(lines.length - 1, h + opts.context);
				for (let k = Math.max(h - opts.context, next); k <= to; k++) {
					out.push({ file: display, line: k + 1, text: lines[k], match: isHit.has(k) });
				}
				next = to + 1;
			}
		}
		matches += hits.length;
		if (matches >= opts.limit) {
			return { lines: out, truncated: true };
		}
	}
	return { lines: out, truncated: false };
}

/** `path:line: text` for matches, `path-line- text` for context, `--` between non-adjacent groups. */
function formatLines(lines: Line[], opts: SearchOptions): string {
	if (opts.filesOnly) {
		return lines.map(l => l.file).join('\n');
	}
	const out: string[] = [];
	let prev: Line | undefined;
	for (const l of lines) {
		if (opts.context && prev && (prev.file !== l.file || l.line !== prev.line + 1)) {
			out.push('--');
		}
		const text = l.text.length > MAX_LINE_CHARS ? l.text.slice(0, MAX_LINE_CHARS) + '…' : l.text;
		const sep = l.match ? ':' : '-';
		out.push(`${l.file}${sep}${l.line}${sep} ${text}`);
		prev = l;
	}
	return out.join('\n');
}

export const grepTool: Tool<Args> = {
	name: 'grep',
	description:
		'Search file contents with a regular expression (ripgrep syntax): the fastest way to find where something is defined or used. ' +
		`Returns "path:line: text" lines, up to ${MAX_MATCHES} matches. ` +
		'Set context_lines to also get the lines around each match (shown as "path-line- text", groups separated by "--"), ' +
		'which is often enough to skip reading the file. Set files_only to list just the files that match. ' +
		'Respects .gitignore and skips node_modules and secret files. Use glob to limit file types, e.g. "*.ts".',
	parameters: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Regular expression to search for.' },
			path: { type: 'string', description: 'File or directory to search, relative to the workspace root. Defaults to the whole workspace.' },
			glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".' },
			case_insensitive: { type: 'boolean', description: 'Ignore case (default false).' },
			context_lines: {
				type: 'integer',
				description: `Lines to show before and after each match (0-${MAX_CONTEXT_LINES}, default 0). With context, at most ${MAX_CONTEXT_MATCHES} matches are returned.`,
			},
			files_only: { type: 'boolean', description: 'Return only the paths of files that contain a match (default false).' },
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
		const filesOnly = args.files_only === true;
		const context = filesOnly ? 0 : Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(args.context_lines ?? 0)));
		const opts: SearchOptions = { context, filesOnly, limit: context ? MAX_CONTEXT_MATCHES : MAX_MATCHES };

		let base: vscode.Uri | undefined;
		let targets: Target[];
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
		let result = rg ? await searchWithRipgrep(rg, args, opts, ctx, targets) : undefined;
		if (!result || (result.error && result.lines.length === 0 && /spawn|ENOENT|EACCES/i.test(result.error))) {
			result = await searchWithJs(regex, args, opts, ctx, base);
		}
		if (result.error) {
			return errorResult(`Search failed: ${result.error}`, 'Search failed');
		}

		const lines = result.lines.filter(l => !isDeniedPath(l.file, ctx.settings.deniedReadGlobs));
		const matchCount = lines.filter(l => l.match).length;
		if (matchCount === 0) {
			return { ok: true, content: `No matches for /${args.pattern}/.`, summary: `Searched "${args.pattern}" (no matches)` };
		}
		const files = new Set(lines.map(l => l.file)).size;
		const more = result.truncated ? '+' : '';
		const note = result.truncated
			? `\n[Stopped at ${opts.limit} ${filesOnly ? 'files' : 'matches'}; narrow the pattern, path or glob.]`
			: '';
		return {
			ok: true,
			content: formatLines(lines, opts) + note,
			summary: filesOnly
				? `Searched "${args.pattern}" (${files}${more} file${files === 1 ? '' : 's'})`
				: `Searched "${args.pattern}" (${matchCount}${more} ${matchCount === 1 ? 'match' : 'matches'} in ${pluralize(files, 'file')})`,
		};
	},
};
