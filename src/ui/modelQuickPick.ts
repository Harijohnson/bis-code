import * as vscode from 'vscode';
import type { ModelCatalog } from '../openrouter/models';
import { formatPrice, formatTokens, shortModelName } from '../shared/format';
import { compareByProviderAndName } from '../shared/modelSearch';
import type { ModelInfo } from '../shared/protocol';

interface ModelItem extends vscode.QuickPickItem {
	modelId?: string;
}

function badges(m: ModelInfo): string {
	return [m.supportsTools && 'tools', m.supportsVision && 'vision', m.supportsReasoning && 'reasoning', m.isFree && 'free']
		.filter(Boolean).join(' · ');
}

function toItem(m: ModelInfo, current: string | undefined): ModelItem {
	const b = badges(m);
	return {
		label: `${m.id === current ? '$(check) ' : ''}${shortModelName(m.name)}`,
		description: m.id,
		detail: `${formatTokens(m.contextLength)} context · ${formatPrice(m)}${b ? ` · ${b}` : ''}`,
		modelId: m.id,
	};
}

/** Native QuickPick version of the chat's model picker (`bisCode.selectModel`). */
export function pickModel(catalog: ModelCatalog, current: string | undefined, recent: string[], toolsOnlyDefault: boolean): Promise<string | undefined> {
	const qp = vscode.window.createQuickPick<ModelItem>();
	let toolsOnly = toolsOnlyDefault;
	const toolsButton = (): vscode.QuickInputButton => ({
		iconPath: new vscode.ThemeIcon(toolsOnly ? 'filter-filled' : 'filter'),
		tooltip: toolsOnly ? 'Showing tool-capable models only (click to show all)' : 'Showing all models (click for tool-capable only)',
	});
	const refreshButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh model list' };

	let baseItems: ModelItem[] = [];
	const build = () => {
		const models = catalog.models.filter(m => !toolsOnly || m.supportsTools).sort(compareByProviderAndName);
		const recentModels = recent.map(id => catalog.find(id)).filter((m): m is ModelInfo => !!m);
		baseItems = [];
		if (recentModels.length) {
			baseItems.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
			baseItems.push(...recentModels.map(m => toItem(m, current)));
		}
		baseItems.push({ label: `All models (${models.length})`, kind: vscode.QuickPickItemKind.Separator });
		baseItems.push(...models.map(m => toItem(m, current)));
		applyValue(qp.value);
		qp.buttons = [toolsButton(), refreshButton];
		qp.busy = catalog.loading;
		if (!catalog.models.length && catalog.error) {
			qp.placeholder = `${catalog.error} — type a model id to use it anyway`;
		}
	};
	const applyValue = (value: string) => {
		const v = value.trim();
		const custom: ModelItem[] = v.includes('/') && !catalog.find(v)
			? [{ label: `$(edit) Use model id "${v}"`, description: 'custom', modelId: v, alwaysShow: true }]
			: [];
		qp.items = [...custom, ...baseItems];
	};

	qp.title = 'bis-code: Select OpenRouter model';
	qp.placeholder = 'Search models by name or id (e.g. "sonnet", "gpt", "gemini")';
	qp.matchOnDescription = true;
	build();
	const disposables = [
		catalog.onDidChange(build),
		qp.onDidChangeValue(applyValue),
		qp.onDidTriggerButton(button => {
			if (button === refreshButton) {
				qp.busy = true;
				void catalog.refresh();
			} else {
				toolsOnly = !toolsOnly;
				build();
			}
		}),
	];

	return new Promise(resolve => {
		let picked: string | undefined;
		disposables.push(
			qp.onDidAccept(() => {
				picked = qp.selectedItems[0]?.modelId;
				qp.hide();
			}),
			qp.onDidHide(() => {
				resolve(picked);
				disposables.forEach(d => d.dispose());
				qp.dispose();
			}),
		);
		qp.show();
	});
}
