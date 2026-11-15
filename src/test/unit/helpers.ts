import * as fs from 'fs';
import * as path from 'path';

/** Fixtures live in src/test/fixtures; compiled tests run from out/test/unit. */
export function fixture(name: string): string {
	return fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', name), 'utf8');
}

/** Splits text into byte chunks of `size` to simulate arbitrary network boundaries. */
export async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	for (let i = 0; i < bytes.length; i += size) {
		yield bytes.slice(i, i + size);
	}
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of gen) {
		out.push(x);
	}
	return out;
}
