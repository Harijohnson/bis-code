import * as vscode from 'vscode';
import { buildExcludeGlob, guardRead, tokenFromSignal } from './common';
import { errorResult, type Tool } from './types';

const MAX_RESULTS = 200;

interface Args {
	pattern: string;
	path?: string;
}

export const globTool: Tool<Args> = {
	name: 'glob',
	description:
		'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Respects files.exclude, search.exclude and skips node_modules. ' +
		`Returns up to ${MAX_RESULTS} paths.`,
	parameters: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Glob pattern relative to path (or the workspace root).' },
			path: { type: 'string', description: 'Directory to search in, relative to the workspace root. Defaults to the whole workspace.' },
		},
		required: ['pattern'],
	},
	permission: 'auto',

	async execute(args, ctx) {
		if (ctx.roots.length === 0) {
			return errorResult('No workspace folder is open.');
		}
		let include: vscode.GlobPattern = args.pattern;
		if (args.path && args.path !== '.') {
			const guarded = guardRead(args.path, ctx);
			if (!guarded.ok) {
				return errorResult(guarded.error, 'Blocked');
			}
			include = new vscode.RelativePattern(guarded.path.uri, args.pattern);
		} else if (ctx.roots.length === 1) {
			include = new vscode.RelativePattern(vscode.Uri.file(ctx.roots[0].fsPath), args.pattern);
		}
		const cancel = tokenFromSignal(ctx.signal);
		let uris: vscode.Uri[];
		try {
			uris = await vscode.workspace.findFiles(include, buildExcludeGlob(), MAX_RESULTS + 1, cancel.token);
		} finally {
			cancel.dispose();
		}
		const multiRoot = ctx.roots.length > 1;
		const paths = uris.map(u => vscode.workspace.asRelativePath(u, multiRoot)).sort();
		const truncated = paths.length > MAX_RESULTS;
		const shown = paths.slice(0, MAX_RESULTS);
		if (shown.length === 0) {
			return { ok: true, content: `No files match ${args.pattern}.`, summary: `Glob ${args.pattern} (no matches)` };
		}
		const note = truncated ? `\n[More than ${MAX_RESULTS} matches; narrow the pattern.]` : '';
		return {
			ok: true,
			content: shown.join('\n') + note,
			summary: `Glob ${args.pattern} (${shown.length}${truncated ? '+' : ''} files)`,
		};
	},
};
