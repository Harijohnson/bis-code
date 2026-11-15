import * as vscode from 'vscode';
import type { ChatController } from '../agent/controller';
import type { ExtensionMessage, WebviewMessage } from '../shared/protocol';
import { getHtml } from './html';

const BATCH_MS = 30;

type Batchable = Extract<ExtensionMessage, { type: 'textDelta' | 'reasoningDelta' | 'toolOutput' }>;

function isBatchable(msg: ExtensionMessage): msg is Batchable {
	return msg.type === 'textDelta' || msg.type === 'reasoningDelta' || msg.type === 'toolOutput';
}

/** Merges a delta into the previous one when they target the same message/call. */
function tryMerge(prev: Batchable, next: Batchable): boolean {
	if (prev.type !== next.type) {
		return false;
	}
	if (prev.type === 'toolOutput' && next.type === 'toolOutput' && prev.callId === next.callId) {
		prev.chunk += next.chunk;
		return true;
	}
	if ((prev.type === 'textDelta' || prev.type === 'reasoningDelta') && (next.type === 'textDelta' || next.type === 'reasoningDelta') && prev.messageId === next.messageId) {
		prev.text += next.text;
		return true;
	}
	return false;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'bisCode.chat';

	private view: vscode.WebviewView | undefined;
	private queue: ExtensionMessage[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly controller: ChatController) {
		controller.setPoster(msg => this.post(msg));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		view.webview.html = getHtml(view.webview, this.extensionUri);
		view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.controller.handle(msg));
		view.onDidDispose(() => {
			// The webview asks for the full state again on `ready` when it comes back.
			this.view = undefined;
			this.controller.viewDisposed();
			this.queue = [];
			clearTimeout(this.timer);
			this.timer = undefined;
		});
	}

	/** Streaming deltas are batched every 30 ms; anything else flushes the batch first to keep order. */
	post(msg: ExtensionMessage): void {
		if (!this.view) {
			return;
		}
		if (isBatchable(msg)) {
			const last = this.queue[this.queue.length - 1];
			if (!(last && isBatchable(last) && tryMerge(last, msg))) {
				this.queue.push({ ...msg });
			}
			this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
			return;
		}
		this.flush();
		void this.view.webview.postMessage(msg);
	}

	private flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const pending = this.queue;
		this.queue = [];
		for (const m of pending) {
			void this.view?.webview.postMessage(m);
		}
	}

	async reveal(): Promise<void> {
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
		}
	}
}
