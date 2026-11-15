export interface DiffLine {
	op: ' ' | '-' | '+';
	line: string;
}

const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** Line diff: trims the common prefix/suffix, then LCS on the middle (falls back to replace-all when huge). */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const out: DiffLine[] = a.slice(0, start).map(line => ({ op: ' ', line }));

	if (midA.length * midB.length > MAX_LCS_CELLS) {
		out.push(...midA.map(line => ({ op: '-' as const, line })), ...midB.map(line => ({ op: '+' as const, line })));
	} else {
		const n = midA.length;
		const m = midB.length;
		const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				out.push({ op: ' ', line: midA[i] });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				out.push({ op: '-', line: midA[i++] });
			} else {
				out.push({ op: '+', line: midB[j++] });
			}
		}
		while (i < n) {
			out.push({ op: '-', line: midA[i++] });
		}
		while (j < m) {
			out.push({ op: '+', line: midB[j++] });
		}
	}
	out.push(...a.slice(endA).map(line => ({ op: ' ' as const, line })));
	return out;
}

export interface DiffPreview {
	text: string;
	added: number;
	removed: number;
}

/** Compact unified-style preview (changed lines with a little context), capped at `maxLines`. */
export function diffPreview(before: string, after: string, maxLines = 60, context = 2): DiffPreview {
	const diff = lineDiff(splitLines(before), splitLines(after));
	const added = diff.filter(d => d.op === '+').length;
	const removed = diff.filter(d => d.op === '-').length;

	const keep = new Array<boolean>(diff.length).fill(false);
	diff.forEach((d, i) => {
		if (d.op !== ' ') {
			for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) {
				keep[k] = true;
			}
		}
	});

	const lines: string[] = [];
	let skipped = false;
	for (let i = 0; i < diff.length; i++) {
		if (!keep[i]) {
			skipped = true;
			continue;
		}
		if (skipped && lines.length) {
			lines.push('⋯');
		}
		skipped = false;
		lines.push(`${diff[i].op} ${diff[i].line}`);
	}
	let text = lines.slice(0, maxLines).join('\n');
	if (lines.length > maxLines) {
		text += `\n⋯ ${lines.length - maxLines} more lines (open the diff to see everything)`;
	}
	return { text, added, removed };
}
