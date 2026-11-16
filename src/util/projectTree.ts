/**
 * Renders the project map: a compact, directory-grouped listing of each workspace folder's files
 * plus a few orientation facts. Pure (no vscode import) so it can be unit tested.
 */

export interface MapRoot {
	/** Workspace folder name. */
	name: string;
	/** Prepended to every path: `name/` in multi-root workspaces, else ''. */
	prefix: string;
	/** `/`-separated paths relative to the folder. */
	files: string[];
	/** The listing stopped at the file cap. */
	truncated?: boolean;
	/** Text of the folder's package.json, when present. */
	packageJson?: string;
}

export interface MapData {
	/** Epoch milliseconds. */
	generatedAt: number;
	/** The listing skipped .gitignore'd files. */
	gitignore: boolean;
	roots: MapRoot[];
}

const MAX_FILES_PER_DIR = 40;
const MAX_SUBDIRS_LISTED = 12;
const MAX_NAMES = 25;
const MAX_EXTENSIONS = 10;
const MAX_KEY_FILES = 20;

/** Manifests and docs worth calling out (lower-case basenames). */
const KEY_FILES = new Set([
	'package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'deno.json',
	'pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile',
	'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'mix.exs', 'pubspec.yaml',
	'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'makefile', 'cmakelists.txt',
	'readme.md', 'agents.md', 'bis.md', 'claude.md', 'contributing.md',
]);
const KEY_FILE_EXTENSIONS = ['.sln', '.csproj'];

interface DirInfo {
	/** Basenames of the files directly in this directory. */
	files: string[];
	/** Files in the whole subtree. */
	total: number;
	subdirs: Set<string>;
}

/** Code-point order, so the output doesn't depend on the locale. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Segment-wise order: a directory comes right before its subdirectories. */
function comparePaths(a: string, b: string): number {
	const pa = a.split('/');
	const pb = b.split('/');
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		if (pa[i] !== pb[i]) {
			return compareText(pa[i], pb[i]);
		}
	}
	return pa.length - pb.length;
}

function depthOf(dir: string): number {
	return dir === '' ? 0 : dir.split('/').length;
}

function basename(file: string): string {
	return file.slice(file.lastIndexOf('/') + 1);
}

function extensionOf(file: string): string | undefined {
	const base = basename(file);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : undefined;
}

function nameList(names: string[], max = MAX_NAMES): string {
	return names.slice(0, max).join(', ') + (names.length > max ? `, … (+${names.length - max} more)` : '');
}

function indexDirs(files: string[]): Map<string, DirInfo> {
	const dirs = new Map<string, DirInfo>();
	const get = (dir: string): DirInfo => {
		let info = dirs.get(dir);
		if (!info) {
			info = { files: [], total: 0, subdirs: new Set() };
			dirs.set(dir, info);
		}
		return info;
	};
	for (const file of files) {
		const parts = file.split('/');
		const base = parts.pop()!;
		get(parts.join('/')).files.push(base);
		for (let k = 0; k <= parts.length; k++) {
			const info = get(parts.slice(0, k).join('/'));
			info.total++;
			if (k < parts.length) {
				info.subdirs.add(parts[k]);
			}
		}
	}
	for (const info of dirs.values()) {
		info.files.sort(compareText);
	}
	return dirs;
}

/** One line per directory down to `maxDepth`; deeper directories are summarized on their ancestor's line. */
function renderTree(dirs: Map<string, DirInfo>, prefix: string, maxDepth: number): string[] {
	const lines: string[] = [];
	for (const dir of [...dirs.keys()].sort(comparePaths)) {
		const depth = depthOf(dir);
		if (depth > maxDepth) {
			continue;
		}
		const info = dirs.get(dir)!;
		const parts: string[] = [];
		if (info.files.length) {
			parts.push(nameList(info.files, MAX_FILES_PER_DIR));
		}
		if (depth === maxDepth && info.subdirs.size) {
			const nested = info.total - info.files.length;
			const subdirs = [...info.subdirs].sort(compareText).map(s => `${s}/`);
			parts.push(`[+${nested} ${nested === 1 ? 'file' : 'files'} in ${nameList(subdirs, MAX_SUBDIRS_LISTED)}]`);
		}
		if (parts.length) {
			const label = prefix + (dir ? `${dir}/` : '');
			lines.push(`${label || './'}: ${parts.join(' ')}`);
		}
	}
	return lines;
}

function packageSummary(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	let pkg: unknown;
	try {
		pkg = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
		return undefined;
	}
	const p = pkg as Record<string, unknown>;
	const keys = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
	const section = (label: string, names: string[]) => (names.length ? `${label}: ${nameList(names)}` : undefined);
	const id = [p.name, p.version].filter((v): v is string => typeof v === 'string' && !!v).join('@');
	const parts = [
		id || undefined,
		section('scripts', keys(p.scripts)),
		section('dependencies', keys(p.dependencies)),
		section('devDependencies', keys(p.devDependencies)),
	].filter((s): s is string => !!s);
	return parts.length ? `package.json: ${parts.join(' · ')}` : undefined;
}

function renderRoot(root: MapRoot, budget: number): string {
	const title = `## ${root.name}`;
	if (root.files.length === 0) {
		return `${title}\nNo files found.`;
	}
	const counts = new Map<string, number>();
	for (const f of root.files) {
		const ext = extensionOf(f);
		if (ext) {
			counts.set(ext, (counts.get(ext) ?? 0) + 1);
		}
	}
	const exts = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).slice(0, MAX_EXTENSIONS);
	const keyFiles = root.files
		.filter(f => {
			const base = basename(f).toLowerCase();
			return depthOf(f) <= 3 && (KEY_FILES.has(base) || KEY_FILE_EXTENSIONS.some(e => base.endsWith(e)));
		})
		.sort(comparePaths)
		.map(f => root.prefix + f);

	const header = [
		title,
		`${root.files.length}${root.truncated ? '+' : ''} files${exts.length ? ` (${exts.map(([e, n]) => `${e} ${n}`).join(', ')})` : ''}` +
			(root.truncated ? '. The listing stopped at the file cap; use glob or list_dir for the rest.' : ''),
		keyFiles.length ? `Key files: ${nameList(keyFiles, MAX_KEY_FILES)}` : undefined,
		packageSummary(root.packageJson),
		'Structure (directory: files):',
	].filter((s): s is string => !!s);

	const dirs = indexDirs(root.files);
	const deepest = [...dirs.keys()].reduce((max, dir) => Math.max(max, depthOf(dir)), 0);
	for (let depth = deepest; depth >= 0; depth--) {
		const text = [...header, ...renderTree(dirs, root.prefix, depth)].join('\n');
		if (text.length <= budget) {
			return text;
		}
	}
	const shallow = [...header, ...renderTree(dirs, root.prefix, 0)].join('\n');
	const note = '\n…[map truncated; use glob or list_dir for the rest]';
	return shallow.slice(0, Math.max(0, budget - note.length)) + note;
}

/** Renders the map within `maxChars`, collapsing deep directories first when it doesn't fit. */
export function renderProjectMap(data: MapData, maxChars: number): string {
	const when = new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ');
	const skipped = data.gitignore ? ".gitignore'd files, node_modules and secret files" : 'node_modules and secret files';
	const intro =
		`Generated ${when} UTC. File names only, grouped by directory; skips ${skipped}. ` +
		'It shows where things are, not what they contain: grep or read a file before relying on its contents.';
	// Each root also costs the blank line that separates it.
	const budget = Math.floor((maxChars - intro.length) / Math.max(1, data.roots.length)) - 2;
	return [intro, ...data.roots.map(r => renderRoot(r, budget))].join('\n\n');
}
