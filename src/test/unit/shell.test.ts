import * as assert from 'assert';
import * as os from 'os';
import { detectShell, runShellCommand, shellInvocation, stripAnsi } from '../../util/shell';

suite('shell', function () {
	// Spawning processes (and taskkill on Windows) can take seconds on machines with antivirus scanning.
	this.timeout(30_000);

	test('detects PowerShell, cmd and POSIX shells', () => {
		assert.strictEqual(detectShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').kind, 'powershell');
		assert.strictEqual(detectShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe').kind, 'powershell');
		assert.strictEqual(detectShell('C:\\Windows\\System32\\cmd.exe').kind, 'cmd');
		assert.strictEqual(detectShell('/bin/zsh').kind, 'posix');
		assert.strictEqual(detectShell('C:\\Program Files\\Git\\bin\\bash.exe').kind, 'posix');
	});

	test('PowerShell commands are passed with -EncodedCommand (no quoting issues)', () => {
		const inv = shellInvocation(detectShell('pwsh'), 'Write-Output "a \'b\' $c"');
		const idx = inv.args.indexOf('-EncodedCommand');
		assert.ok(idx >= 0);
		const script = Buffer.from(inv.args[idx + 1], 'base64').toString('utf16le');
		assert.ok(script.includes('Write-Output "a \'b\' $c"'));
		assert.ok(inv.args.includes('-NonInteractive') && inv.args.includes('-NoProfile'));
	});

	test('POSIX shells use -c', () => {
		assert.deepStrictEqual(shellInvocation(detectShell('/bin/bash'), 'echo hi').args, ['-c', 'echo hi']);
	});

	test('strips ANSI escape codes', () => {
		assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok'), 'red ok');
	});

	test('runs a command, streams output and reports the exit code', async () => {
		const chunks: string[] = [];
		const res = await runShellCommand(detectShell(undefined), 'node -e "console.log(\'hello\'); process.exit(3)"', {
			cwd: os.tmpdir(),
			timeoutMs: 20_000,
			signal: new AbortController().signal,
			onOutput: c => chunks.push(c),
		});
		assert.strictEqual(res.exitCode, 3);
		assert.match(res.output, /hello/);
		assert.match(chunks.join(''), /hello/);
	});

	test('kills the process on timeout', async function () {
		this.timeout(20_000);
		const started = Date.now();
		const res = await runShellCommand(detectShell(undefined), 'node -e "setTimeout(() => {}, 60000)"', {
			cwd: os.tmpdir(),
			timeoutMs: 1000,
			signal: new AbortController().signal,
			onOutput: () => undefined,
		});
		assert.ok(res.timedOut);
		assert.ok(Date.now() - started < 10_000);
	});

	test('abort stops the command', async function () {
		this.timeout(20_000);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 500);
		const res = await runShellCommand(detectShell(undefined), 'node -e "setTimeout(() => {}, 60000)"', {
			cwd: os.tmpdir(),
			timeoutMs: 60_000,
			signal: ac.signal,
			onOutput: () => undefined,
		});
		assert.ok(res.aborted);
	});
});
