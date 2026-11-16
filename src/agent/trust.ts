import * as vscode from 'vscode';

/** Opens VS Code's Workspace Trust editor. Extensions can't grant trust themselves. */
export const MANAGE_TRUST_COMMAND = 'workbench.trust.manage';

const TRUST_ACTION = 'Manage Workspace Trust';

/**
 * Asks the user to trust the workspace so the agent can `action` (e.g. "edit files"). Shows a modal
 * explaining why, opens the Workspace Trust editor, and waits until trust is granted, the user
 * cancels the "waiting" notification, or the turn is stopped. Resolves true once trusted.
 */
export async function requestWorkspaceTrust(action: string, signal: AbortSignal): Promise<boolean> {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		`bis-code needs a trusted workspace to ${action}.`,
		{
			modal: true,
			detail: 'This folder is open in Restricted Mode, which blocks file edits and commands. ' +
				'Trust it only if you trust its authors. Otherwise bis-code continues read-only.',
		},
		TRUST_ACTION,
	);
	if (choice !== TRUST_ACTION || signal.aborted) {
		return vscode.workspace.isTrusted;
	}
	await vscode.commands.executeCommand(MANAGE_TRUST_COMMAND);
	return waitForTrust(signal);
}

function waitForTrust(signal: AbortSignal): Thenable<boolean> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'bis-code is waiting for you to trust this workspace…', cancellable: true },
		(_progress, token) => new Promise<boolean>(resolve => {
			if (vscode.workspace.isTrusted || signal.aborted) {
				resolve(vscode.workspace.isTrusted);
				return;
			}
			const subscriptions: vscode.Disposable[] = [];
			const finish = (trusted: boolean) => {
				signal.removeEventListener('abort', onAbort);
				subscriptions.forEach(d => d.dispose());
				resolve(trusted);
			};
			const onAbort = () => finish(false);
			signal.addEventListener('abort', onAbort, { once: true });
			subscriptions.push(
				vscode.workspace.onDidGrantWorkspaceTrust(() => finish(true)),
				token.onCancellationRequested(() => finish(false)),
			);
		}),
	);
}
