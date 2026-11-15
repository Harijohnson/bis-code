import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceRoot {
	name: string;
	fsPath: string;
}

export type ResolvedPath =
	| { ok: true; absPath: string; relPath: string; root: WorkspaceRoot }
	| { ok: false; error: string };

/** True when `child` is `parent` or inside it. Case-insensitive on Windows (via path.relative). */
export function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function realpathOfExisting(p: string): string {
	const missing: string[] = [];
	let current = p;
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) {
			return p;
		}
		missing.unshift(path.basename(current));
		current = parent;
	}
	try {
		return path.join(fs.realpathSync.native(current), ...missing);
	} catch {
		return p;
	}
}

/**
 * Resolves a model-supplied path against the workspace folders and rejects anything
 * outside them: `..` traversal, absolute paths elsewhere, and symlinks that escape.
 * Relative paths resolve against the first folder, or against a folder whose name is
 * the first path segment in a multi-root workspace.
 */
export function resolveWorkspacePath(input: string, roots: WorkspaceRoot[]): ResolvedPath {
	if (roots.length === 0) {
		return { ok: false, error: 'No workspace folder is open.' };
	}
	let p = (input ?? '').trim().replace(/^["']|["']$/g, '');
	if (p === '' || p === '/') {
		p = '.';
	}
	let abs: string | undefined;
	if (path.isAbsolute(p)) {
		const direct = path.resolve(p);
		if (roots.some(r => isInside(r.fsPath, direct))) {
			abs = direct;
		} else if (!/^[\\/](?![\\/])/.test(p)) {
			return { ok: false, error: `Path is outside the workspace: ${input}` };
		}
		// Otherwise `/src/x.ts` (single leading slash) is treated as workspace-relative below.
	}
	if (abs === undefined) {
		const rel = p.replace(/^[\\/]+/, '');
		const first = rel.split(/[\\/]/)[0];
		const named = roots.length > 1 ? roots.find(r => r.name === first) : undefined;
		abs = named
			? path.resolve(named.fsPath, rel.slice(first.length).replace(/^[\\/]+/, '') || '.')
			: path.resolve(roots[0].fsPath, rel);
	}

	const root = roots.find(r => isInside(r.fsPath, abs));
	if (!root) {
		return { ok: false, error: `Path is outside the workspace: ${input}` };
	}
	const realRoot = realpathOfExisting(root.fsPath);
	if (!isInside(realRoot, realpathOfExisting(abs))) {
		return { ok: false, error: `Path resolves outside the workspace through a symlink: ${input}` };
	}
	const relPath = path.relative(root.fsPath, abs).split(path.sep).join('/') || '.';
	return { ok: true, absPath: abs, relPath, root };
}

/** Writes to any `.git` directory are always denied. */
export function isGitInternalPath(relPath: string): boolean {
	return relPath.split('/').some(seg => seg.toLowerCase() === '.git');
}

/** Path shown to the model and in the UI: relative, prefixed with the folder name in multi-root workspaces. */
export function displayPath(resolved: { relPath: string; root: WorkspaceRoot }, roots: WorkspaceRoot[]): string {
	return roots.length > 1 ? `${resolved.root.name}/${resolved.relPath}` : resolved.relPath;
}
