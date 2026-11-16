// Fuzzy matching for the @-mention picker. Pure: compiled into both the extension and the webview.

import type { MentionItem } from './protocol';

export interface FuzzyMatch {
	score: number;
	/** Indexes into the target that matched the query, for highlighting. */
	positions: number[];
}

const SEPARATORS = '/\\-_. ';

function isWordStart(target: string, i: number): boolean {
	if (i === 0 || SEPARATORS.includes(target[i - 1])) {
		return true;
	}
	const prev = target[i - 1];
	const ch = target[i];
	return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

/** Last path segment, ignoring a trailing `/` on folders. */
export function baseName(path: string): string {
	const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
	return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * Scores `query` as a case-insensitive subsequence of `target`. Undefined when it doesn't match.
 * Contiguous runs, word starts and hits in the file name score higher; long paths score lower.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | undefined {
	const q = query.toLowerCase();
	if (!q) {
		return { score: 0, positions: [] };
	}
	const t = target.toLowerCase();
	const name = baseName(t);
	const nameStart = t.length - name.length - (t.endsWith('/') ? 1 : 0);

	// Prefer a match that sits entirely inside the file name, then a plain substring, then a subsequence.
	const inName = name.indexOf(q);
	if (inName >= 0) {
		const start = nameStart + inName;
		return {
			score: 100 + (inName === 0 ? 40 : isWordStart(target, start) ? 20 : 0) + (q.length === name.length ? 30 : 0) - t.length * 0.1,
			positions: Array.from({ length: q.length }, (_, k) => start + k),
		};
	}
	const sub = t.indexOf(q);
	if (sub >= 0) {
		return {
			score: 60 + (isWordStart(target, sub) ? 15 : 0) - t.length * 0.1,
			positions: Array.from({ length: q.length }, (_, k) => sub + k),
		};
	}

	const positions: number[] = [];
	let score = 0;
	let from = 0;
	for (const ch of q) {
		const i = t.indexOf(ch, from);
		if (i < 0) {
			return undefined;
		}
		score += 1;
		if (positions.length && i === positions[positions.length - 1] + 1) {
			score += 4;
		}
		if (isWordStart(target, i)) {
			score += 6;
		}
		if (i >= nameStart) {
			score += 2;
		}
		positions.push(i);
		from = i + 1;
	}
	return { score: score - t.length * 0.1, positions };
}

/**
 * Ranks candidates for the picker. With an empty query, `recent` (open editors) come first,
 * then shallow folders and files.
 */
export function searchMentions(candidates: MentionItem[], query: string, limit: number, recent: string[] = []): MentionItem[] {
	const q = query.trim();
	const recentRank = new Map(recent.map((p, i) => [p, i]));
	if (!q) {
		const byPath = new Map(candidates.map(c => [c.path, c]));
		const top = recent.map(p => byPath.get(p)).filter((c): c is MentionItem => !!c);
		const seen = new Set(top.map(c => c.path));
		const depth = (p: string) => p.replace(/\/$/, '').split('/').length;
		const rest = candidates
			.filter(c => !seen.has(c.path))
			.sort((a, b) => depth(a.path) - depth(b.path) || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.path.localeCompare(b.path));
		return [...top, ...rest].slice(0, limit);
	}
	const scored: { item: MentionItem; score: number }[] = [];
	for (const item of candidates) {
		const m = fuzzyMatch(q, item.path);
		if (m) {
			scored.push({ item, score: m.score + (recentRank.has(item.path) ? 10 : 0) });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.item.path.length - b.item.path.length);
	return scored.slice(0, limit).map(s => s.item);
}

/**
 * The `@query` being typed at `caret`, if any. The `@` must start the text or follow whitespace,
 * and the query runs to the caret without whitespace.
 */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
	let i = caret - 1;
	while (i >= 0 && !/\s/.test(text[i]) && text[i] !== '@') {
		i--;
	}
	if (i < 0 || text[i] !== '@' || (i > 0 && !/\s/.test(text[i - 1]))) {
		return undefined;
	}
	return { start: i, query: text.slice(i + 1, caret) };
}

/** The mentioned paths that are still written as `@path` in the text, in order of appearance. */
export function activeMentions(text: string, mentions: Iterable<string>): string[] {
	const found: { path: string; at: number }[] = [];
	for (const path of new Set(mentions)) {
		const at = indexOfMention(text, path);
		if (at >= 0) {
			found.push({ path, at });
		}
	}
	return found.sort((a, b) => a.at - b.at).map(f => f.path);
}

function indexOfMention(text: string, path: string, from = 0): number {
	const token = `@${path}`;
	let at = text.indexOf(token, from);
	while (at >= 0) {
		const before = at === 0 || /\s/.test(text[at - 1]);
		const after = text[at + token.length];
		if (before && (after === undefined || /[\s.,;:!?)]/.test(after))) {
			return at;
		}
		at = text.indexOf(token, at + 1);
	}
	return -1;
}

export type MentionSegment = { text: string; mention?: undefined } | { text: string; mention: string };

/** Splits text into plain runs and `@path` mentions, for rendering. */
export function splitMentions(text: string, mentions: string[]): MentionSegment[] {
	if (!mentions.length) {
		return [{ text }];
	}
	// Longest first, so `@src/a.ts` wins over `@src/`.
	const sorted = [...new Set(mentions)].sort((a, b) => b.length - a.length);
	const segments: MentionSegment[] = [];
	let pos = 0;
	while (pos < text.length) {
		let best: { at: number; path: string } | undefined;
		for (const path of sorted) {
			const at = indexOfMention(text, path, pos);
			if (at >= 0 && (!best || at < best.at)) {
				best = { at, path };
			}
		}
		if (!best) {
			break;
		}
		if (best.at > pos) {
			segments.push({ text: text.slice(pos, best.at) });
		}
		segments.push({ text: `@${best.path}`, mention: best.path });
		pos = best.at + best.path.length + 1;
	}
	if (pos < text.length) {
		segments.push({ text: text.slice(pos) });
	}
	return segments;
}
