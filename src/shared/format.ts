import type { ModelInfo } from './protocol';

/** 128000 → "128k", 1048576 → "1M". */
export function formatTokens(n: number): string {
	if (!n || n < 0) {
		return '?';
	}
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 2 : 1).replace(/\.?0+$/, '')}M`;
	}
	if (n >= 1000) {
		return `${Math.round(n / 1000)}k`;
	}
	return String(n);
}

function perMillion(pricePerToken: number): string {
	const v = pricePerToken * 1_000_000;
	if (v === 0) {
		return '$0';
	}
	if (v < 0.01) {
		return `$${v.toFixed(4).replace(/0+$/, '')}`;
	}
	return `$${Number(v.toFixed(2))}`;
}

/** "$3 / $15 per 1M", "free" or "variable". */
export function formatPrice(model: ModelInfo): string {
	if (model.isFree) {
		return 'free';
	}
	if (model.promptPrice < 0 || model.completionPrice < 0) {
		return 'variable';
	}
	return `${perMillion(model.promptPrice)} / ${perMillion(model.completionPrice)} per 1M`;
}

export function formatCost(usd: number | undefined): string {
	if (usd === undefined || Number.isNaN(usd)) {
		return '';
	}
	if (usd === 0) {
		return '$0';
	}
	if (usd < 0.01) {
		return `$${usd.toFixed(4)}`;
	}
	return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** "Anthropic: Claude Sonnet 4" → "Claude Sonnet 4". */
export function shortModelName(name: string): string {
	const idx = name.indexOf(': ');
	return idx > 0 && idx < 30 ? name.slice(idx + 2) : name;
}

export function modelLabel(modelId: string | undefined, models: ModelInfo[]): string {
	if (!modelId) {
		return 'Select model';
	}
	const m = models.find(x => x.id === modelId);
	return m ? `${shortModelName(m.name)} · ${formatTokens(m.contextLength)}` : modelId;
}
