import { isDeniedPath } from '../util/glob';

/**
 * Commands that are blocked even when the user approves everything.
 * Patterns are deliberately broad; a false positive only costs a re-phrase.
 */
const DENYLIST: { pattern: RegExp; reason: string }[] = [
	{ pattern: /--no-preserve-root/i, reason: 'rm --no-preserve-root' },
	{ pattern: /\bformat(?:\.com)?\s+[a-z]:/i, reason: 'formatting a drive' },
	{ pattern: /\b(?:del|erase)\b[^;&|]*\/s\b[^;&|]*\b[a-z]:\\?\*?(?:\s|$|[;&|"'])/i, reason: 'recursive delete of a drive root' },
	{ pattern: /\b(?:rd|rmdir)\b[^;&|]*\/s\b[^;&|]*\b[a-z]:\\?(?:\s|$|[;&|"'])/i, reason: 'recursive delete of a drive root' },
	{ pattern: /\bRemove-Item\b(?=[^;&|]*-Recurse)[^;&|]*\s['"]?[a-z]:\\?\*?['"]?(?:\s|$|[;&|])/i, reason: 'recursive delete of a drive root' },
	{ pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: 'creating a filesystem' },
	{ pattern: /\bdd\b[^;&|]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk)/i, reason: 'writing directly to a disk device' },
	{ pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
	{ pattern: /\bgit\s+push\b(?=[^;&|]*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+))(?=[^;&|]*\b(?:main|master)\b)/i, reason: 'force push to main/master' },
	{ pattern: /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i, reason: 'piping a download into a shell' },
	{ pattern: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(?:iex|Invoke-Expression)\b/i, reason: 'piping a download into Invoke-Expression' },
	{ pattern: /\b(?:shutdown|reboot|halt|poweroff)\b(?:\s|$)/i, reason: 'shutting down the machine' },
	{ pattern: /\bStop-Computer\b|\bRestart-Computer\b/i, reason: 'shutting down the machine' },
	{ pattern: /\bchmod\s+(?:-[a-z]*\s+)*-?R?\s*777\s+\/(?:\s|$)/i, reason: 'chmod 777 on the filesystem root' },
];

/** `/`, `/*`, a top-level directory like `/usr`, `~`, `$HOME`, or a drive root. */
function isRootOrHomeTarget(target: string): boolean {
	const t = target.replace(/^["']|["']$/g, '');
	return /^\/[^/]*\/?\*?$/.test(t)
		|| /^(?:~|\$HOME|\$\{HOME\})\/?\*?$/.test(t)
		|| /^[a-z]:[\\/]?\*?$/i.test(t);
}

/** `rm` with both recursive and force flags aimed at a root or home directory. */
function isDangerousRm(command: string): boolean {
	for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		while (tokens[0] === 'sudo' || tokens[0] === 'command' || tokens[0] === 'env') {
			tokens.shift();
		}
		if (tokens[0] !== 'rm' && tokens[0] !== '/bin/rm') {
			continue;
		}
		const flags = tokens.slice(1).filter(t => t.startsWith('-'));
		const targets = tokens.slice(1).filter(t => !t.startsWith('-'));
		const recursive = flags.some(f => f === '--recursive' || (/^-[a-z]+$/i.test(f) && /r/i.test(f)));
		const force = flags.some(f => f === '--force' || (/^-[a-z]+$/i.test(f) && f.includes('f')));
		if (recursive && force && targets.some(isRootOrHomeTarget)) {
			return true;
		}
	}
	return false;
}

/** Returns the reason a command is blocked, or undefined when it may run (with approval). */
export function deniedReason(command: string): string | undefined {
	const normalized = command.replace(/\s+/g, ' ').trim();
	if (isDangerousRm(normalized)) {
		return 'recursive force delete of a root or home directory';
	}
	for (const { pattern, reason } of DENYLIST) {
		if (pattern.test(normalized)) {
			return reason;
		}
	}
	return undefined;
}

/**
 * True when any word of the command names a secret file (e.g. `cat .env`, `type certs\server.pem`).
 * Such commands always need approval, even when allow-listed.
 */
export function mentionsDeniedPath(command: string, deniedGlobs: string[]): boolean {
	return command
		.split(/[\s'"`=<>|;&(),]+/)
		.map(t => t.replace(/^\.[\\/]/, ''))
		.some(t => t.length > 0 && isDeniedPath(t, deniedGlobs));
}

/** Chaining, piping, substitution or redirection: such commands never match the allowlist. */
export function hasShellOperators(command: string): boolean {
	return /&&|\|\||[;|&`<>\n\r]|\$\(/.test(command);
}

/** True when a simple command starts with an allow-listed prefix (followed by end or whitespace). */
export function isAllowListed(command: string, prefixes: string[]): boolean {
	const cmd = command.trim();
	if (!cmd || hasShellOperators(cmd)) {
		return false;
	}
	return prefixes.some(raw => {
		const prefix = raw.trim();
		return !!prefix && (cmd === prefix || cmd.startsWith(prefix + ' '));
	});
}

/** The prefix offered by "Always allow": the program plus its subcommand, e.g. `npm test`, `git status`. */
export function suggestPrefix(command: string): string | undefined {
	const cmd = command.trim();
	if (!cmd || hasShellOperators(cmd)) {
		return undefined;
	}
	const tokens = cmd.split(/\s+/);
	if (tokens.length >= 2 && /^[a-z][\w:.-]*$/i.test(tokens[1])) {
		// `npm run build` → keep the script name too
		if (tokens.length >= 3 && /^(run|run-script|exec|x)$/.test(tokens[1]) && /^[\w:.-]+$/.test(tokens[2])) {
			return tokens.slice(0, 3).join(' ');
		}
		return tokens.slice(0, 2).join(' ');
	}
	return tokens[0];
}
