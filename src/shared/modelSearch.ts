import type { ModelInfo } from './protocol';

export interface ModelFilters {
	toolsOnly: boolean;
	freeOnly: boolean;
	visionOnly: boolean;
	/** Provider slug (part of the id before `/`), or undefined for all. */
	provider?: string;
}

export const NO_FILTERS: ModelFilters = { toolsOnly: false, freeOnly: false, visionOnly: false };

function words(s: string): string[] {
	return s.split(/[^a-z0-9.]+/).filter(Boolean);
}

/** Lower is better; undefined means no match. */
function termScore(term: string, name: string, id: string): number | undefined {
	if (name === term || id === term) {
		return 0;
	}
	if (name.startsWith(term) || id.startsWith(term)) {
		return 1;
	}
	if (words(name).some(w => w.startsWith(term)) || words(id).some(w => w.startsWith(term))) {
		return 2;
	}
	if (name.includes(term) || id.includes(term)) {
		return 3;
	}
	return undefined;
}

/**
 * Ranks a model against a query: exact, then prefix, then word prefix, then substring.
 * Multi-word queries require every word to match. Returns undefined when it doesn't match.
 */
export function scoreModel(model: ModelInfo, query: string): number | undefined {
	const q = query.trim().toLowerCase();
	if (!q) {
		return 0;
	}
	const name = model.name.toLowerCase();
	const id = model.id.toLowerCase();
	const whole = termScore(q, name, id);
	if (whole !== undefined) {
		return whole;
	}
	const terms = q.split(/\s+/);
	if (terms.length < 2) {
		return undefined;
	}
	let total = 0;
	for (const term of terms) {
		const s = termScore(term, name, id);
		if (s === undefined) {
			return undefined;
		}
		total += s;
	}
	return 4 + total;
}

export function matchesFilters(model: ModelInfo, filters: ModelFilters): boolean {
	if (filters.toolsOnly && !model.supportsTools) {
		return false;
	}
	if (filters.freeOnly && !model.isFree) {
		return false;
	}
	if (filters.visionOnly && !model.supportsVision) {
		return false;
	}
	if (filters.provider && model.provider !== filters.provider) {
		return false;
	}
	return true;
}

export function compareByProviderAndName(a: ModelInfo, b: ModelInfo): number {
	return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name);
}

/** Filters, then ranks by score (when there is a query) or provider + name. */
export function searchModels(models: ModelInfo[], query: string, filters: ModelFilters): ModelInfo[] {
	const scored: { model: ModelInfo; score: number }[] = [];
	for (const model of models) {
		if (!matchesFilters(model, filters)) {
			continue;
		}
		const score = scoreModel(model, query);
		if (score !== undefined) {
			scored.push({ model, score });
		}
	}
	scored.sort((a, b) => a.score - b.score || compareByProviderAndName(a.model, b.model));
	return scored.map(s => s.model);
}

export function providersOf(models: ModelInfo[]): string[] {
	return [...new Set(models.map(m => m.provider))].sort();
}
