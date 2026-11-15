import * as vscode from 'vscode';
import type { KeyValidation } from '../openrouter/client';
import type { DevEnv } from './devEnv';

export const SECRET_KEY = 'bisCode.openRouterApiKey';

/**
 * Resolves the OpenRouter key (first match wins):
 * 1. `.env` in the extension root, Development mode only (never stored)
 * 2. SecretStorage
 * 3. nothing → onboarding
 *
 * The key never leaves the extension host.
 */
export class ApiKeyManager implements vscode.Disposable {
	private cached: string | undefined;
	private loaded = false;
	/** Set when the .env key got a 401 or the user cleared keys during development. */
	private envDisabled = false;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly devEnv: DevEnv,
		private readonly validate: (key: string) => Promise<KeyValidation>,
	) {
		// Keeps every open window in sync.
		this.disposables.push(secrets.onDidChange(e => {
			if (e.key === SECRET_KEY) {
				this.loaded = false;
				this.cached = undefined;
				this.emitter.fire();
			}
		}));
	}

	async getKey(): Promise<string | undefined> {
		if (this.devEnv.apiKey && !this.envDisabled) {
			return this.devEnv.apiKey;
		}
		if (!this.loaded) {
			this.cached = await this.secrets.get(SECRET_KEY);
			this.loaded = true;
		}
		return this.cached;
	}

	async hasKey(): Promise<boolean> {
		return !!(await this.getKey());
	}

	/** Asks for a key with a native password box, validates it with `GET /key`, then stores it. */
	async promptAndStore(): Promise<boolean> {
		let prompt = 'Paste your OpenRouter API key. Create one at https://openrouter.ai/keys';
		while (true) {
			const input = await vscode.window.showInputBox({
				title: 'bis-code: OpenRouter API key',
				prompt,
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'sk-or-v1-...',
				validateInput: v => (v.trim() ? undefined : 'Enter an API key'),
			});
			if (input === undefined) {
				return false;
			}
			const key = input.trim();
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Checking OpenRouter API key…' },
				() => this.validate(key),
			);
			if (result.ok) {
				await this.store(key);
				const { usage, limit } = result.info;
				const credit = typeof limit === 'number' ? ` Credit used: $${(usage ?? 0).toFixed(2)} of $${limit.toFixed(2)}.` : '';
				vscode.window.showInformationMessage(`bis-code is connected to OpenRouter.${credit}`);
				return true;
			}
			if (result.reason === 'invalid') {
				prompt = 'OpenRouter rejected that key (invalid key). Paste a different key.';
				continue;
			}
			const choice = await vscode.window.showWarningMessage(
				`Couldn't verify the key: ${result.message}`,
				{ modal: true, detail: 'You can save it anyway and it will be checked on the next request.' },
				'Save Anyway', 'Try Again',
			);
			if (choice === 'Save Anyway') {
				await this.store(key);
				return true;
			}
			if (choice !== 'Try Again') {
				return false;
			}
		}
	}

	async store(key: string): Promise<void> {
		this.envDisabled = true;
		await this.secrets.store(SECRET_KEY, key);
		this.cached = key;
		this.loaded = true;
		this.emitter.fire();
	}

	async clear(): Promise<void> {
		this.envDisabled = true;
		await this.secrets.delete(SECRET_KEY);
		this.cached = undefined;
		this.loaded = true;
		this.emitter.fire();
	}

	/** Called on a 401: forget the key in memory so onboarding shows, without touching storage. */
	invalidate(): void {
		if (this.devEnv.apiKey && !this.envDisabled) {
			this.envDisabled = true;
		} else {
			this.cached = undefined;
			this.loaded = true;
		}
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
