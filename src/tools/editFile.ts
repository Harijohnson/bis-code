import * as vscode from 'vscode';
import { diffPreview } from '../util/lineDiff';
import { checkReadBeforeWrite, fileKey, guardWrite, statOrUndefined } from './common';
import { applyStringEdit } from './editMatch';
import { errorResult, rejectedResult, type Tool } from './types';

const SNIPPET_CONTEXT = 3;
const MAX_SNIPPET_LINES = 60;

interface Args {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

/** Numbered lines around the first replacement, so the model can check the result. */
function snippet(content: string, offset: number, newText: string): string {
	const lines = content.split(/\r?\n/);
	const firstLine = content.slice(0, offset).split(/\r?\n/).length; // 1-based
	const newLines = newText.split(/\r?\n/).length;
	const from = Math.max(1, firstLine - SNIPPET_CONTEXT);
	const to = Math.min(lines.length, firstLine + newLines - 1 + SNIPPET_CONTEXT, from + MAX_SNIPPET_LINES - 1);
	const width = String(to).length;
	return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width, ' ')}\t${l}`).join('\n');
}

export const editFileTool: Tool<Args> = {
	name: 'edit_file',
	description:
		'Replace an exact string in a file. old_string must match the file exactly (whitespace and indentation included, ' +
		'without the line-number prefixes from read_file) and must be unique unless replace_all is true. ' +
		'Include enough surrounding lines to make it unique. The file must have been read with read_file first. ' +
		'The user reviews a diff before it is applied.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			old_string: { type: 'string', description: 'Exact text to replace.' },
			new_string: { type: 'string', description: 'Replacement text.' },
			replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
		},
		required: ['path', 'old_string', 'new_string'],
	},
	permission: 'edit',

	async execute(args, ctx) {
		if (!vscode.workspace.isTrusted) {
			return errorResult('File edits are disabled in untrusted workspaces.');
		}
		const guarded = guardWrite(args.path, ctx);
		if (!guarded.ok) {
			return errorResult(guarded.error, 'Blocked');
		}
		const p = guarded.path;
		const stat = await statOrUndefined(p.uri);
		if (!stat) {
			return errorResult(`File not found: ${p.display}. Use write_file to create it.`, `Not found: ${p.display}`);
		}
		if (stat.type & vscode.FileType.Directory) {
			return errorResult(`${p.display} is a directory.`);
		}
		const notRead = checkReadBeforeWrite(ctx, p, stat);
		if (notRead) {
			return errorResult(notRead, 'Must read first');
		}

		const doc = await vscode.workspace.openTextDocument(p.uri);
		const before = doc.getText();
		const version = doc.version;
		let result = applyStringEdit(before, args.old_string, args.new_string, args.replace_all ?? false);
		if (!result.ok) {
			return errorResult(result.error, 'Edit failed: no unique match');
		}

		const preview = diffPreview(before, result.content);
		const approval = await ctx.approveEdit(
			p.uri, before, result.content,
			`Edit ${p.display}  (+${preview.added} −${preview.removed})\n${preview.text}`,
		);
		if (!approval.approved) {
			return rejectedResult('edit', approval.reason);
		}

		// The user may have typed in the file while the approval was pending.
		if (doc.version !== version) {
			result = applyStringEdit(doc.getText(), args.old_string, args.new_string, args.replace_all ?? false);
			if (!result.ok) {
				return errorResult(`${p.display} changed while waiting for approval. Read it again. (${result.error})`, 'File changed');
			}
		}

		const edit = new vscode.WorkspaceEdit();
		for (const m of result.matches) {
			edit.replace(p.uri, new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), result.newText);
		}
		if (!(await vscode.workspace.applyEdit(edit))) {
			return errorResult(`VS Code could not apply the edit to ${p.display}.`, 'Edit failed');
		}
		await doc.save();

		const after = await statOrUndefined(p.uri);
		if (after) {
			ctx.session.readFiles[fileKey(p.absPath)] = after.mtime;
		}
		const n = result.matches.length;
		return {
			ok: true,
			content: `Edited ${p.display}: replaced ${n} occurrence${n === 1 ? '' : 's'}. Updated region:\n${snippet(doc.getText(), result.matches[0].start, result.newText)}`,
			summary: `Edited ${p.display} (+${preview.added} −${preview.removed})`,
		};
	},
};
