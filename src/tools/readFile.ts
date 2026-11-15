import * as vscode from 'vscode';
import { fileKey, guardRead, readText, statOrUndefined } from './common';
import { errorResult, type Tool } from './types';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface Args {
	path: string;
	offset?: number;
	limit?: number;
}

export const readFileTool: Tool<Args> = {
	name: 'read_file',
	description:
		'Read a text file from the workspace. Returns lines prefixed with their 1-based line number and a tab ' +
		`(the prefix is not part of the file). Reads up to ${DEFAULT_LIMIT} lines by default; use offset/limit for large files. ` +
		'You must read a file before editing or overwriting it.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			offset: { type: 'integer', description: '1-based line number to start reading from.' },
			limit: { type: 'integer', description: `Maximum number of lines to read (default ${DEFAULT_LIMIT}).` },
		},
		required: ['path'],
	},
	permission: 'auto',

	async execute(args, ctx) {
		const guarded = guardRead(args.path, ctx);
		if (!guarded.ok) {
			return errorResult(guarded.error, 'Blocked');
		}
		const { uri, display, absPath } = guarded.path;
		const stat = await statOrUndefined(uri);
		if (!stat) {
			return errorResult(`File not found: ${display}`, `Not found: ${display}`);
		}
		if (stat.type & vscode.FileType.Directory) {
			return errorResult(`${display} is a directory. Use list_dir instead.`, `${display} is a directory`);
		}
		if (stat.size > MAX_FILE_BYTES) {
			return errorResult(`${display} is too large (${Math.round(stat.size / 1024 / 1024)} MB). Use grep to find the relevant part.`, 'File too large');
		}
		const read = await readText(uri, display);
		if (!read.ok) {
			return errorResult(read.error, 'Binary file');
		}

		ctx.session.readFiles[fileKey(absPath)] = stat.mtime;

		if (read.text.length === 0) {
			return { ok: true, content: `${display} is empty.`, summary: `Read ${display} (empty)` };
		}
		const lines = read.text.split(/\r?\n/);
		if (lines.length > 1 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		const start = Math.max(1, Math.floor(args.offset ?? 1));
		const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));
		if (start > lines.length) {
			return errorResult(`offset ${start} is past the end of ${display} (${lines.length} lines).`, 'Offset past end');
		}
		const end = Math.min(lines.length, start + limit - 1);
		const width = String(end).length;
		const body = lines
			.slice(start - 1, end)
			.map((line, i) => {
				const text = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…[line truncated]' : line;
				return `${String(start + i).padStart(width, ' ')}\t${text}`;
			})
			.join('\n');
		const partial = start > 1 || end < lines.length;
		const note = partial ? `\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset/limit to read more.]` : '';
		const count = end - start + 1;
		return {
			ok: true,
			content: body + note,
			summary: `Read ${display} (${partial ? `lines ${start}-${end} of ${lines.length}` : `${count} line${count === 1 ? '' : 's'}`})`,
		};
	},
};
