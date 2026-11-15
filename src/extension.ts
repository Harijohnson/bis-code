import * as vscode from 'vscode';
import { ChatController } from './agent/controller';
import { PermissionGate } from './agent/permissions';
import { SessionManager } from './agent/session';
import { ApiKeyManager } from './config/apiKeyManager';
import { loadDevEnv } from './config/devEnv';
import { Settings } from './config/settings';
import { OpenRouterClient } from './openrouter/client';
import { ModelCatalog } from './openrouter/models';
import { DiffPreviewProvider } from './tools/diffPreview';
import { createToolRegistry } from './tools/registry';
import { pickModel } from './ui/modelQuickPick';
import { ModelStatusBar } from './ui/statusBar';
import { ChatViewProvider } from './webview/ChatViewProvider';

/** Returned from activate() so integration tests can drive the extension. */
export interface BisCodeApi {
	controller: ChatController;
	apiKeys: ApiKeyManager;
	catalog: ModelCatalog;
}

let controller: ChatController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<BisCodeApi> {
	const devEnv = loadDevEnv(context);
	const settings = new Settings(devEnv);

	// The key only ever lives here, in the extension host.
	let apiKeys: ApiKeyManager | undefined;
	const client = new OpenRouterClient({
		getKey: () => apiKeys?.getKey() ?? Promise.resolve(undefined),
		getBaseUrl: () => settings.baseUrl,
	});
	apiKeys = new ApiKeyManager(context.secrets, devEnv, key => client.validateKey(key));

	const catalog = new ModelCatalog(context.globalState, () => client.fetchModels(), () => settings.baseUrl);
	catalog.init();

	const sessions = new SessionManager(vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'sessions'));
	await sessions.init();

	const diff = new DiffPreviewProvider();
	controller = new ChatController({
		context, settings, apiKeys, client, catalog, sessions, diff,
		gate: new PermissionGate(),
		registry: createToolRegistry(),
	});
	await controller.init();
	const chat = controller;

	const provider = new ChatViewProvider(context.extensionUri, chat);
	const statusBar = new ModelStatusBar(catalog);
	statusBar.update(chat.selectedModel);

	const selectModel = async () => {
		const id = await pickModel(catalog, chat.selectedModel, chat.recentModels, settings.showOnlyToolModels);
		if (id) {
			await chat.selectModel(id);
		}
	};

	context.subscriptions.push(
		apiKeys,
		diff,
		statusBar,
		{ dispose: () => void chat.dispose() },
		vscode.workspace.registerTextDocumentContentProvider(DiffPreviewProvider.scheme, diff),
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
		chat.onDidChangeModel(() => statusBar.update(chat.selectedModel)),

		vscode.commands.registerCommand('bisCode.focus', () => provider.reveal()),
		vscode.commands.registerCommand('bisCode.newChat', async () => {
			await provider.reveal();
			await chat.newChat();
		}),
		vscode.commands.registerCommand('bisCode.selectModel', selectModel),
		vscode.commands.registerCommand('bisCode.setApiKey', () => apiKeys!.promptAndStore()),
		vscode.commands.registerCommand('bisCode.clearApiKey', () => chat.clearApiKey()),
		vscode.commands.registerCommand('bisCode.refreshModels', async () => {
			await catalog.refresh();
			if (catalog.error) {
				vscode.window.showErrorMessage(`bis-code: ${catalog.error}`);
			} else {
				vscode.window.showInformationMessage(`bis-code: loaded ${catalog.models.length} models.`);
			}
		}),
		vscode.commands.registerCommand('bisCode.addSelectionToChat', async () => {
			if (!chat.addSelectionToComposer()) {
				vscode.window.showInformationMessage('bis-code: select some code first.');
				return;
			}
			await provider.reveal();
		}),
		vscode.commands.registerCommand('bisCode.stop', () => chat.stop()),
	);

	return { controller: chat, apiKeys, catalog };
}

export async function deactivate(): Promise<void> {
	await controller?.dispose();
	controller = undefined;
}
