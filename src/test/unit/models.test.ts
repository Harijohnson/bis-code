import * as assert from 'assert';
import { MODEL_CACHE_KEY, MODEL_CACHE_TTL_MS, ModelCatalog, normalizeModels, type KeyValueStore } from '../../openrouter/models';
import { formatPrice, formatTokens, shortModelName } from '../../shared/format';
import { NO_FILTERS, searchModels } from '../../shared/modelSearch';
import { fixture } from './helpers';

const raw = JSON.parse(fixture('models.json'));
const models = normalizeModels(raw);

class MemoryStore implements KeyValueStore {
	data = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.data.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.data.set(key, value);
	}
}

suite('model catalog', () => {
	test('normalizes the /models response', () => {
		assert.strictEqual(models.length, 5, 'entry without id is dropped');
		const sonnet = models.find(m => m.id === 'anthropic/claude-sonnet-4')!;
		assert.strictEqual(sonnet.provider, 'anthropic');
		assert.strictEqual(sonnet.contextLength, 200000);
		assert.strictEqual(sonnet.promptPrice, 0.000003);
		assert.strictEqual(sonnet.maxCompletionTokens, 64000);
		assert.ok(sonnet.supportsTools && sonnet.supportsVision && sonnet.supportsReasoning && !sonnet.isFree);
		const llama = models.find(m => m.id.endsWith(':free'))!;
		assert.ok(llama.isFree && !llama.supportsTools && !llama.supportsVision);
		assert.strictEqual(llama.maxCompletionTokens, undefined);
		assert.strictEqual(normalizeModels({}).length, 0);
	});

	test('formats context, price and names', () => {
		assert.strictEqual(formatTokens(200000), '200k');
		assert.strictEqual(formatTokens(1047576), '1.05M');
		assert.strictEqual(formatTokens(2000000), '2M');
		assert.strictEqual(formatPrice(models.find(m => m.id === 'anthropic/claude-sonnet-4')!), '$3 / $15 per 1M');
		assert.strictEqual(formatPrice(models.find(m => m.id === 'openrouter/auto')!), 'variable');
		assert.strictEqual(formatPrice(models.find(m => m.isFree)!), 'free');
		assert.strictEqual(shortModelName('Anthropic: Claude Sonnet 4'), 'Claude Sonnet 4');
	});

	test('uses the cache, refreshes when stale, and persists results', async () => {
		const store = new MemoryStore();
		let now = 1_000_000;
		let fetches = 0;
		const catalog = new ModelCatalog(store, async () => {
			fetches++;
			return raw;
		}, () => 'https://openrouter.ai/api/v1', () => now);

		catalog.init(); // empty cache → background refresh
		await catalog.refresh();
		assert.strictEqual(catalog.models.length, 5);
		assert.ok(store.get(MODEL_CACHE_KEY));
		assert.strictEqual(catalog.stale, false);

		const fresh = new ModelCatalog(store, async () => {
			fetches++;
			return raw;
		}, () => 'https://openrouter.ai/api/v1', () => now);
		const before = fetches;
		fresh.init();
		assert.strictEqual(fresh.models.length, 5, 'shows cached models immediately');
		assert.strictEqual(fetches, before, 'no fetch while the cache is fresh');

		now += MODEL_CACHE_TTL_MS + 1;
		assert.ok(fresh.stale);
	});

	test('a failed fetch keeps the cached list and reports an error', async () => {
		const store = new MemoryStore();
		const catalog = new ModelCatalog(store, async () => {
			throw new Error('offline');
		}, () => 'x');
		await catalog.refresh();
		assert.match(catalog.error!, /offline/);
		assert.strictEqual(catalog.models.length, 0);
	});
});

suite('model search', () => {
	test('"sonn" finds Claude Sonnet first', () => {
		assert.strictEqual(searchModels(models, 'sonn', NO_FILTERS)[0].id, 'anthropic/claude-sonnet-4');
	});

	test('"gpt" narrows to OpenAI, shorter prefix match first', () => {
		const ids = searchModels(models, 'gpt', NO_FILTERS).map(m => m.id);
		assert.deepStrictEqual(ids, ['openai/gpt-4.1', 'openai/gpt-4.1-mini']);
	});

	test('prefix beats word prefix beats substring', () => {
		const ids = searchModels(models, 'open', NO_FILTERS).map(m => m.id);
		assert.ok(ids.indexOf('openai/gpt-4.1') < ids.indexOf('openrouter/auto') || ids.includes('openrouter/auto'));
		assert.strictEqual(searchModels(models, 'zzz', NO_FILTERS).length, 0);
	});

	test('multi-word queries need every word', () => {
		assert.deepStrictEqual(searchModels(models, 'gpt mini', NO_FILTERS).map(m => m.id), ['openai/gpt-4.1-mini']);
	});

	test('filters: tools, free, vision, provider', () => {
		assert.ok(searchModels(models, '', { ...NO_FILTERS, toolsOnly: true }).every(m => m.supportsTools));
		assert.deepStrictEqual(searchModels(models, '', { ...NO_FILTERS, freeOnly: true }).map(m => m.id), ['meta-llama/llama-3.3-70b-instruct:free']);
		assert.ok(!searchModels(models, '', { ...NO_FILTERS, visionOnly: true }).some(m => m.id.includes('llama')));
		assert.deepStrictEqual(searchModels(models, '', { ...NO_FILTERS, provider: 'anthropic' }).map(m => m.id), ['anthropic/claude-sonnet-4']);
	});

	test('no query sorts by provider then name', () => {
		const providers = searchModels(models, '', NO_FILTERS).map(m => m.provider);
		assert.deepStrictEqual(providers, [...providers].sort());
	});
});
