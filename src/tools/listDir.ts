import * as vscode from 'vscode';
import { guardRead, statOrUndefined } from './common';
import { errorResult, type Tool } from './types';

const SKIP = new Set(['node_modules', '.git']);
const MAX_ENTRIES = 500;

interface Args {
	path?: string;
}

export const listDirTool: Tool<Args> = {
	name: 'list_dir',
	description:
		'List the entries of a workspace directory. Directories end with "/". ' +
		'node_modules and .git are skipped unless you list them directly.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Directory path relative to the workspace root. Use "." for the root.' },
		},
		required: ['path'],
	},
	permission: 'auto',

	async execute(args, ctx) {
		const guarded = guardRead(args.path ?? '.', ctx);
		if (!guarded.ok) {
			return errorResult(guarded.error, 'Blocked');
		}
		const { uri, display } = guarded.path;
		const stat = await statOrUndefined(uri);
		if (!stat) {
			return errorResult(`Directory not found: ${display}`, `Not found: ${display}`);
		}
		if (!(stat.type & vscode.FileType.Directory)) {
			return errorResult(`${display} is a file. Use read_file instead.`, `${display} is a file`);
		}
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const visible = entries
			.filter(([name]) => !SKIP.has(name))
			.map(([name, type]) => {
				const isDir = (type & vscode.FileType.Directory) !== 0;
				const isLink = (type & vscode.FileType.SymbolicLink) !== 0;
				return { name, isDir, label: `${name}${isDir ? '/' : ''}${isLink ? ' (symlink)' : ''}` };
			})
			.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
		const skipped = entries.length - visible.length;
		const shown = visible.slice(0, MAX_ENTRIES).map(e => e.label);
		const notes: string[] = [];
		if (visible.length > MAX_ENTRIES) {
			notes.push(`…and ${visible.length - MAX_ENTRIES} more entries`);
		}
		if (skipped) {
			notes.push(`(skipped ${[...SKIP].filter(s => entries.some(([n]) => n === s)).join(', ')})`);
		}
		const content = shown.length ? [...shown, ...notes].join('\n') : `${display} is empty.`;
		return { ok: true, content, summary: `Listed ${display === '.' ? 'workspace root' : display} (${visible.length} entries)` };
	},
};
