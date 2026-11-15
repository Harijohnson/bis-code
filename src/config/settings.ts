import * as vscode from 'vscode';
import { DEFAULT_BASE_URL } from '../openrouter/types';
import type { DevEnv } from './devEnv';

const SECTION = 'bisCode';

function cfg(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(SECTION);
}

function isSet<T>(key: string): boolean {
	const i = cfg().inspect<T>(key);
	return !!i && (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined);
}

/** Typed getters for `bisCode.*` settings. Read fresh each time so changes apply immediately. */
export class Settings {
	constructor(private readonly devEnv: DevEnv) { }

	get defaultModel(): string | undefined {
		return cfg().get<string>('defaultModel')?.trim() || this.devEnv.defaultModel;
	}

	get maxIterations(): number {
		return Math.max(1, cfg().get<number>('maxIterations', 25));
	}

	get maxOutputTokens(): number {
		return Math.max(256, cfg().get<number>('maxOutputTokens', 8192));
	}

	get temperature(): number | undefined {
		const t = cfg().get<number | null>('temperature', null);
		return typeof t === 'number' ? t : undefined;
	}

	get autoApproveEdits(): boolean {
		return cfg().get<boolean>('autoApproveEdits', false);
	}

	get allowedCommands(): string[] {
		return cfg().get<string[]>('allowedCommands', []).filter(s => typeof s === 'string' && s.trim());
	}

	get deniedReadGlobs(): string[] {
		return cfg().get<string[]>('deniedReadGlobs', []);
	}

	get commandTimeoutMs(): number {
		return Math.max(1000, cfg().get<number>('commandTimeoutMs', 120_000));
	}

	/** An explicit setting wins, then OPENROUTER_BASE_URL from .env (dev only), then the default. */
	get baseUrl(): string {
		if (isSet<string>('baseUrl')) {
			return cfg().get<string>('baseUrl')?.trim() || DEFAULT_BASE_URL;
		}
		return this.devEnv.baseUrl || DEFAULT_BASE_URL;
	}

	get showOnlyToolModels(): boolean {
		return cfg().get<boolean>('showOnlyToolModels', true);
	}

	async addAllowedCommand(prefix: string): Promise<void> {
		const current = cfg().inspect<string[]>('allowedCommands');
		const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		const existing = (target === vscode.ConfigurationTarget.Workspace ? current?.workspaceValue : current?.globalValue) ?? [];
		if (!existing.includes(prefix)) {
			await cfg().update('allowedCommands', [...existing, prefix], target);
		}
	}

	static affects(e: vscode.ConfigurationChangeEvent, key?: string): boolean {
		return e.affectsConfiguration(key ? `${SECTION}.${key}` : SECTION);
	}
}
