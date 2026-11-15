import type { ModelInfo } from '../shared/protocol';

export const MODEL_CACHE_KEY = 'bisCode.modelCache';
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The subset of vscode.Memento the catalog needs (keeps this module testable without VS Code). */
export interface KeyValueStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

interface ModelCache {
	fetchedAt: number;
	baseUrl: string;
	models: ModelInfo[];
}

interface RawModel {
	id?: string;
	name?: string;
	description?: string;
	context_length?: number;
	pricing?: { prompt?: string | number; completion?: string | number };
	architecture?: { input_modalities?: string[] };
	supported_parameters?: string[];
	top_provider?: { max_completion_tokens?: number | null; context_length?: number | null };
}

function price(value: string | number | undefined): number {
	const n = typeof value === 'number' ? value : Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/** Normalizes the `/models` response into ModelInfo records. Invalid entries are dropped. */
export function normalizeModels(raw: unknown): ModelInfo[] {
	const data = (raw as { data?: RawModel[] } | undefined)?.data;
	if (!Array.isArray(data)) {
		return [];
	}
	const out: ModelInfo[] = [];
	for (const m of data) {
		if (!m || typeof m.id !== 'string' || !m.id) {
			continue;
		}
		const supportedParameters = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
		const inputModalities = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'];
		const promptPrice = price(m.pricing?.prompt);
		const completionPrice = price(m.pricing?.completion);
		const description = typeof m.description === 'string' ? m.description : '';
		out.push({
			id: m.id,
			name: typeof m.name === 'string' && m.name ? m.name : m.id,
			description: description.length > 300 ? description.slice(0, 297) + '…' : description,
			provider: m.id.includes('/') ? m.id.slice(0, m.id.indexOf('/')) : m.id,
			contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
			promptPrice,
			completionPrice,
			inputModalities,
			supportedParameters,
			maxCompletionTokens: m.top_provider?.max_completion_tokens ?? undefined,
			supportsTools: supportedParameters.includes('tools'),
			supportsVision: inputModalities.includes('image'),
			supportsReasoning: supportedParameters.includes('reasoning') || supportedParameters.includes('include_reasoning'),
			isFree: m.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0),
		});
	}
	return out;
}

export class ModelCatalog {
	private _models: ModelInfo[] = [];
	private fetchedAt = 0;
	private _error: string | undefined;
	private inflight: Promise<void> | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly store: KeyValueStore,
		private readonly fetchModels: () => Promise<unknown>,
		private readonly getBaseUrl: () => string,
		private readonly now: () => number = Date.now,
	) { }

	get models(): ModelInfo[] {
		return this._models;
	}

	get stale(): boolean {
		return this.now() - this.fetchedAt > MODEL_CACHE_TTL_MS;
	}

	get error(): string | undefined {
		return this._error;
	}

	get loading(): boolean {
		return this.inflight !== undefined;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private fire(): void {
		for (const l of this.listeners) {
			l();
		}
	}

	/** Shows the cached list right away and refreshes in the background when stale. */
	init(): void {
		const cache = this.store.get<ModelCache>(MODEL_CACHE_KEY);
		if (cache && cache.baseUrl === this.getBaseUrl() && Array.isArray(cache.models)) {
			this._models = cache.models;
			this.fetchedAt = cache.fetchedAt;
		}
		if (this.stale || this._models.length === 0) {
			void this.refresh();
		}
	}

	refresh(): Promise<void> {
		this.inflight ??= this.doRefresh().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async doRefresh(): Promise<void> {
		try {
			const models = normalizeModels(await this.fetchModels());
			if (models.length === 0) {
				throw new Error('OpenRouter returned no models.');
			}
			this._models = models;
			this.fetchedAt = this.now();
			this._error = undefined;
			await this.store.update(MODEL_CACHE_KEY, { fetchedAt: this.fetchedAt, baseUrl: this.getBaseUrl(), models } satisfies ModelCache);
		} catch (err) {
			this._error = `Could not load models: ${err instanceof Error ? err.message : String(err)}`;
		}
		this.fire();
	}

	find(id: string | undefined): ModelInfo | undefined {
		return id ? this._models.find(m => m.id === id) : undefined;
	}
}
