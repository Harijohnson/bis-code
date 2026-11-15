import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

export type ShellKind = 'powershell' | 'cmd' | 'posix';

export interface ShellInfo {
	path: string;
	kind: ShellKind;
	/** Friendly name for the system prompt, e.g. "PowerShell". */
	name: string;
}

/** Classifies `vscode.env.shell` (or the platform default when it's empty). */
export function detectShell(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): ShellInfo {
	const p = shellPath?.trim() || (platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh');
	const base = path.basename(p).toLowerCase().replace(/\.exe$/, '');
	if (base === 'pwsh' || base === 'powershell') {
		return { path: p, kind: 'powershell', name: base === 'pwsh' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1' };
	}
	if (base === 'cmd') {
		return { path: p, kind: 'cmd', name: 'cmd.exe' };
	}
	return { path: p, kind: 'posix', name: base };
}

export interface Invocation {
	file: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

/** Builds the argv that runs `command` in the given shell. */
export function shellInvocation(shell: ShellInfo, command: string): Invocation {
	switch (shell.kind) {
		case 'powershell': {
			// -EncodedCommand avoids every quoting pitfall. Exit with the native exit code when there is one.
			const script = [
				`$ProgressPreference = 'SilentlyContinue'`,
				`try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}`,
				command,
				`$__ok = $?; $__code = $LASTEXITCODE`,
				`if (-not $__ok) { if ($__code) { exit $__code } else { exit 1 } }`,
				`exit 0`,
			].join('\n');
			return {
				file: shell.path,
				args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
			};
		}
		case 'cmd':
			return { file: shell.path, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
		default:
			return { file: shell.path, args: ['-c', command] };
	}
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/** Kills the whole process tree (`taskkill /T /F` on Windows, the process group elsewhere). */
export function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
		return;
	}
	const pid = child.pid;
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		child.kill('SIGTERM');
	}
	setTimeout(() => {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}, 2000).unref();
}

export interface RunOptions {
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
	onOutput(chunk: string): void;
	/** Max chars kept in memory; the middle is dropped beyond this. */
	maxBuffer?: number;
}

export interface RunResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	aborted: boolean;
	error?: string;
}

/** Runs a command in the user's shell, streaming combined stdout/stderr. */
export function runShellCommand(shell: ShellInfo, command: string, opts: RunOptions): Promise<RunResult> {
	const maxBuffer = opts.maxBuffer ?? 1_000_000;
	return new Promise(resolve => {
		if (opts.signal.aborted) {
			resolve({ exitCode: null, output: '', timedOut: false, aborted: true });
			return;
		}
		const inv = shellInvocation(shell, command);
		let child: ChildProcess;
		try {
			child = spawn(inv.file, inv.args, {
				cwd: opts.cwd,
				env: {
					...process.env,
					PAGER: 'cat',
					GIT_PAGER: 'cat',
					GIT_TERMINAL_PROMPT: '0',
					NO_COLOR: '1',
					FORCE_COLOR: '0',
					TERM: 'dumb',
					CI: process.env.CI ?? '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				detached: process.platform !== 'win32',
				windowsVerbatimArguments: inv.windowsVerbatimArguments,
			});
		} catch (err) {
			resolve({ exitCode: null, output: '', timedOut: false, aborted: false, error: err instanceof Error ? err.message : String(err) });
			return;
		}

		let output = '';
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const decoders = { out: new TextDecoder('utf-8'), err: new TextDecoder('utf-8') };

		const append = (text: string) => {
			const clean = stripAnsi(text).replace(/\r(?!\n)/g, '\n');
			if (!clean) {
				return;
			}
			output += clean;
			if (output.length > maxBuffer) {
				const half = Math.floor(maxBuffer / 2);
				output = `${output.slice(0, half)}\n…[output truncated]…\n${output.slice(output.length - half)}`;
			}
			opts.onOutput(clean);
		};
		child.stdout?.on('data', (b: Buffer) => append(decoders.out.decode(b, { stream: true })));
		child.stderr?.on('data', (b: Buffer) => append(decoders.err.decode(b, { stream: true })));

		const finish = (exitCode: number | null, error?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			opts.signal.removeEventListener('abort', onAbort);
			append(decoders.out.decode() + decoders.err.decode());
			resolve({ exitCode, output, timedOut, aborted, error });
		};
		const stop = () => {
			killTree(child);
			// If grandchildren keep the pipes open, don't wait forever.
			setTimeout(() => finish(child.exitCode), 3000).unref();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, opts.timeoutMs);
		opts.signal.addEventListener('abort', onAbort, { once: true });

		child.on('error', err => finish(null, err.message));
		child.on('close', code => finish(code));
	});
}
