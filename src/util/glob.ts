function escapeRegex(c: string): string {
	return /[.+^$()|\\/]/.test(c) ? '\\' + c : c;
}

/** Converts a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to an anchored RegExp over `/`-separated paths. */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
	let re = '';
	let groupDepth = 0;
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const atSegmentStart = i === 0 || glob[i - 1] === '/';
				if (atSegmentStart && glob[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 3;
				} else {
					re += '.*';
					i += 2;
				}
				continue;
			}
			re += '[^/]*';
			i++;
			continue;
		}
		if (c === '?') {
			re += '[^/]';
			i++;
			continue;
		}
		if (c === '{') {
			groupDepth++;
			re += '(?:';
			i++;
			continue;
		}
		if (c === '}' && groupDepth > 0) {
			groupDepth--;
			re += ')';
			i++;
			continue;
		}
		if (c === ',' && groupDepth > 0) {
			re += '|';
			i++;
			continue;
		}
		if (c === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end > i + 1) {
				let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
				if (cls.startsWith('!')) {
					cls = '^' + cls.slice(1);
				}
				re += `[${cls}]`;
				i = end + 1;
				continue;
			}
		}
		re += escapeRegex(c);
		i++;
	}
	return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

/** Matches a relative path against a glob. Globs without `/` match the basename at any depth. */
export function matchGlob(relPath: string, glob: string, caseInsensitive = false): boolean {
	const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
	const g = glob.replace(/\\/g, '/');
	const re = globToRegExp(g, caseInsensitive);
	if (!g.includes('/')) {
		return re.test(p.slice(p.lastIndexOf('/') + 1));
	}
	return re.test(p);
}

/**
 * True when the path matches a deny glob and no `!exception` glob.
 * Exceptions win regardless of their position in the list.
 */
export function isDeniedPath(relPath: string, globs: string[], caseInsensitive = process.platform === 'win32'): boolean {
	let denied = false;
	for (const glob of globs) {
		if (glob.startsWith('!')) {
			if (matchGlob(relPath, glob.slice(1), caseInsensitive)) {
				return false;
			}
		} else if (!denied && matchGlob(relPath, glob, caseInsensitive)) {
			denied = true;
		}
	}
	return denied;
}
