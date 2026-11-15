/** Default cap for tool output sent to the model. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

/** Keeps the head and the tail, with `…[truncated N chars]…` in between. */
export function truncateMiddle(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
	if (text.length <= max) {
		return text;
	}
	const head = Math.floor(max / 2);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[truncated ${text.length - max} chars]…\n${text.slice(text.length - tail)}`;
}

export function truncateEnd(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + '…';
}

/** True when the buffer looks binary (NUL byte in the first 8 KB). */
export function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8192);
	for (let i = 0; i < n; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

export function newId(prefix = ''): string {
	return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function pluralize(n: number, word: string, plural = word + 's'): string {
	return `${n} ${n === 1 ? word : plural}`;
}
