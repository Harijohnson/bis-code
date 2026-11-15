export interface EditMatch {
	start: number;
	end: number;
}

export type EditResult =
	| { ok: true; content: string; matches: EditMatch[]; newText: string }
	| { ok: false; error: string };

/**
 * Exact string replacement used by `edit_file`.
 * Fails when `oldString` is missing, or matches more than once without `replaceAll`.
 * If the file uses CRLF, line breaks in both strings are converted to CRLF first,
 * because the model sees files with plain `\n` line breaks.
 */
export function applyStringEdit(content: string, oldString: string, newString: string, replaceAll = false): EditResult {
	if (oldString === '') {
		return { ok: false, error: 'old_string must not be empty. Use write_file to create or overwrite a file.' };
	}
	if (oldString === newString) {
		return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };
	}
	let oldText = oldString;
	let newText = newString;
	if (content.includes('\r\n')) {
		oldText = oldText.replace(/\r?\n/g, '\r\n');
		newText = newText.replace(/\r?\n/g, '\r\n');
	}

	const matches: EditMatch[] = [];
	let from = 0;
	while (true) {
		const idx = content.indexOf(oldText, from);
		if (idx < 0) {
			break;
		}
		matches.push({ start: idx, end: idx + oldText.length });
		from = idx + oldText.length;
	}

	if (matches.length === 0) {
		return {
			ok: false,
			error: 'old_string was not found in the file. Read the file again and copy the exact text, including whitespace and indentation (without line-number prefixes).',
		};
	}
	if (matches.length > 1 && !replaceAll) {
		return {
			ok: false,
			error: `old_string matches ${matches.length} places. Include more surrounding lines to make it unique, or set replace_all to true.`,
		};
	}

	let result = '';
	let last = 0;
	for (const m of matches) {
		result += content.slice(last, m.start) + newText;
		last = m.end;
	}
	result += content.slice(last);
	return { ok: true, content: result, matches, newText };
}
