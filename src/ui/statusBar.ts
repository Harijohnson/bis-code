import * as vscode from 'vscode';
import type { ModelCatalog } from '../openrouter/models';
import { formatPrice, modelLabel } from '../shared/format';

/** Shows the current model; clicking it opens the model picker. */
export class ModelStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('bisCode.model', vscode.StatusBarAlignment.Right, 100);

	constructor(private readonly catalog: ModelCatalog) {
		this.item.name = 'bis-code model';
		this.item.command = 'bisCode.selectModel';
	}

	update(modelId: string | undefined): void {
		const model = this.catalog.find(modelId);
		this.item.text = `$(sparkle) ${modelLabel(modelId, this.catalog.models)}`;
		this.item.tooltip = model
			? `bis-code: ${model.name}\n${model.id}\n${formatPrice(model)}${model.supportsTools ? '' : '\n⚠ No tool support (Chat mode only)'}`
			: 'bis-code: click to select an OpenRouter model';
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}
