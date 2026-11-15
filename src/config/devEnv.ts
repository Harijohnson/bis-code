import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface DevEnv {
	apiKey?: string;
	defaultModel?: string;
	baseUrl?: string;
}

/**
 * Reads `<extensionRoot>/.env`, but only when running from source (F5).
 * An installed .vsix never looks for it. Values are returned, never written to process.env.
 */
export function loadDevEnv(context: vscode.ExtensionContext): DevEnv {
	if (context.extensionMode !== vscode.ExtensionMode.Development) {
		return {};
	}
	let parsed: Record<string, string>;
	try {
		parsed = dotenv.parse(fs.readFileSync(path.join(context.extensionPath, '.env')));
	} catch {
		return {};
	}
	const value = (name: string) => parsed[name]?.trim() || undefined;
	return {
		apiKey: value('OPENROUTER_API_KEY'),
		defaultModel: value('OPENROUTER_DEFAULT_MODEL'),
		baseUrl: value('OPENROUTER_BASE_URL'),
	};
}
