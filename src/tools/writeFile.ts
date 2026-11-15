import * as vscode from 'vscode';
import { diffPreview } from '../util/lineDiff';
import { checkReadBeforeWrite, countLines, fileKey, guardWrite, openDocument, readText, statOrUndefined } from './common';
import { errorResult, rejectedResult, type Tool } from './types';

interface Args {
	path: string;
	content: string;
}

function sameText(a: string, b: string): boolean {
	return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

export const writeFileTool: Tool<Args> = {
	name: 'write_file',
	description:
		'Create a new file or completely overwrite an existing one. Prefer edit_file for changes to existing files. ' +
		'An existing file must have been read with read_file first. Parent folders are created as needed. ' +
		'The user reviews a diff before it is applied.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			content: { type: 'string', description: 'The full file content.' },
		},
		required: ['path', 'content'],
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
		let original: string | undefined;
		if (stat) {
			if (stat.type & vscode.FileType.Directory) {
				return errorResult(`${p.display} is a directory.`);
			}
			const notRead = checkReadBeforeWrite(ctx, p, stat);
			if (notRead) {
				return errorResult(notRead, 'Must read first');
			}
			const read = await readText(p.uri, p.display);
			if (!read.ok) {
				return errorResult(read.error);
			}
			original = read.text;
			if (sameText(original, args.content)) {
				return { ok: true, content: `${p.display} already has exactly this content; nothing changed.`, summary: `No changes to ${p.display}` };
			}
		}

		const preview = diffPreview(original ?? '', args.content);
		const header = `${stat ? 'Overwrite' : 'Create'} ${p.display}  (+${preview.added} −${preview.removed})`;
		const approval = await ctx.approveEdit(p.uri, original, args.content, `${header}\n${preview.text}`);
		if (!approval.approved) {
			return rejectedResult('edit', approval.reason);
		}

		const edit = new vscode.WorkspaceEdit();
		if (stat) {
			const doc = await vscode.workspace.openTextDocument(p.uri);
			edit.replace(p.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), args.content);
			if (!(await vscode.workspace.applyEdit(edit))) {
				return errorResult(`VS Code could not apply the edit to ${p.display}.`, 'Edit failed');
			}
			await doc.save();
		} else {
			edit.createFile(p.uri, { contents: new TextEncoder().encode(args.content) });
			if (!(await vscode.workspace.applyEdit(edit))) {
				return errorResult(`VS Code could not create ${p.display}.`, 'Create failed');
			}
			const doc = openDocument(p.uri);
			if (doc?.isDirty) {
				await doc.save();
			}
		}

		const after = await statOrUndefined(p.uri);
		if (after) {
			ctx.session.readFiles[fileKey(p.absPath)] = after.mtime;
		}
		const lines = countLines(args.content);
		return {
			ok: true,
			content: `${stat ? 'Overwrote' : 'Created'} ${p.display} (${lines} lines).`,
			summary: `${stat ? 'Wrote' : 'Created'} ${p.display} (+${preview.added} −${preview.removed})`,
		};
	},
};
