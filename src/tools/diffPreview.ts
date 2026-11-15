import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Serves proposed file contents under the `bis-code-proposed:` scheme and opens
 * `vscode.diff(original, proposed)` while an edit waits for approval.
 */
export class DiffPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	static readonly scheme = 'bis-code-proposed';

	private readonly contents = new Map<string, string>();
	private readonly open = new Map<string, { left: vscode.Uri; right: vscode.Uri; title: string }>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	/** Opens the diff without stealing focus from the chat. */
	async show(callId: string, file: vscode.Uri, original: string | undefined, proposed: string): Promise<void> {
		// Keep the real path so the diff editor picks the right language.
		const right = vscode.Uri.from({ scheme: DiffPreviewProvider.scheme, path: file.path, query: `call=${callId}` });
		this.contents.set(right.toString(), proposed);
		let left = file;
		if (original === undefined) {
			left = vscode.Uri.from({ scheme: DiffPreviewProvider.scheme, path: file.path, query: `call=${callId}&side=empty` });
			this.contents.set(left.toString(), '');
		}
		const title = `bis-code: ${path.basename(file.fsPath)} (proposed)`;
		this.open.set(callId, { left, right, title });
		this.emitter.fire(right);
		await this.reveal(callId);
	}

	/** Re-opens a pending diff (the "Show diff" button). */
	async reveal(callId: string): Promise<boolean> {
		const entry = this.open.get(callId);
		if (!entry) {
			return false;
		}
		await vscode.commands.executeCommand('vscode.diff', entry.left, entry.right, entry.title, { preview: true, preserveFocus: true });
		return true;
	}

	async close(callId: string): Promise<void> {
		const entry = this.open.get(callId);
		if (!entry) {
			return;
		}
		this.open.delete(callId);
		const right = entry.right.toString();
		const tabs = vscode.window.tabGroups.all
			.flatMap(g => g.tabs)
			.filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right);
		if (tabs.length) {
			await vscode.window.tabGroups.close(tabs, true).then(undefined, () => undefined);
		}
		this.contents.delete(right);
		this.contents.delete(entry.left.toString());
	}

	dispose(): void {
		this.emitter.dispose();
		this.contents.clear();
		this.open.clear();
	}
}
