import * as vscode from 'vscode';
import { isInside } from './pathGuard';
import { guardRead } from './common';
import { errorResult, type Tool } from './types';

const MAX_DIAGNOSTICS = 200;

interface Args {
	path?: string;
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
	return s === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
}

export const diagnosticsTool: Tool<Args> = {
	name: 'get_diagnostics',
	description:
		'Get errors and warnings that VS Code language services report (type errors, lint problems). ' +
		'Pass a path for one file, or omit it for the whole workspace. Language servers usually only analyze files that have been opened.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path relative to the workspace root. Omit for all files.' },
		},
	},
	permission: 'auto',

	async execute(args, ctx) {
		let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
		if (args.path) {
			const guarded = guardRead(args.path, ctx);
			if (!guarded.ok) {
				return errorResult(guarded.error, 'Blocked');
			}
			entries = [[guarded.path.uri, vscode.languages.getDiagnostics(guarded.path.uri)]];
		} else {
			entries = vscode.languages.getDiagnostics()
				.filter(([uri]) => uri.scheme === 'file' && ctx.roots.some(r => isInside(r.fsPath, uri.fsPath)));
		}

		const multiRoot = ctx.roots.length > 1;
		const lines: string[] = [];
		let errors = 0;
		let warnings = 0;
		for (const [uri, diags] of entries) {
			const rel = vscode.workspace.asRelativePath(uri, multiRoot);
			for (const d of diags) {
				if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {
					continue;
				}
				if (d.severity === vscode.DiagnosticSeverity.Error) {
					errors++;
				} else {
					warnings++;
				}
				if (lines.length < MAX_DIAGNOSTICS) {
					const code = typeof d.code === 'object' ? d.code.value : d.code;
					const source = [d.source, code].filter(x => x !== undefined && x !== '').join(' ');
					lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severityLabel(d.severity)}: ${d.message.replace(/\s*\n\s*/g, ' ')}${source ? ` [${source}]` : ''}`);
				}
			}
		}
		const summary = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
		if (!lines.length) {
			return { ok: true, content: 'No errors or warnings.', summary: `Diagnostics: none${args.path ? ` in ${args.path}` : ''}` };
		}
		const more = errors + warnings > lines.length ? `\n…and ${errors + warnings - lines.length} more` : '';
		return { ok: true, content: `${summary}\n${lines.join('\n')}${more}`, summary: `Diagnostics: ${summary}` };
	},
};
