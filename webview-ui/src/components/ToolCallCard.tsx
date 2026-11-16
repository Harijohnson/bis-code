import { useState } from 'react';
import type { ToolCallView, ToolStatus } from '../../../src/shared/protocol';
import { post } from '../vscodeApi';
import { ApprovalCard } from './ApprovalCard';
import { Codicon, IconButton } from './common';

const TOOL_ICONS: Record<string, string> = {
	read_file: 'file',
	list_dir: 'folder',
	glob: 'search',
	grep: 'search',
	get_diagnostics: 'warning',
	write_file: 'new-file',
	edit_file: 'edit',
	run_command: 'terminal',
	explore: 'telescope',
	delegate: 'robot',
};

const LIVE_OUTPUT_LINES = 12;
const MAX_ARG_CHARS = 4000;

function str(args: unknown, key: string): string {
	const v = (args as Record<string, unknown> | null)?.[key];
	return typeof v === 'string' ? v : '';
}

/** Title shown before the tool reports its own one-line summary. */
function describe(call: ToolCallView): string {
	const a = call.args;
	switch (call.name) {
		case 'read_file': return `Read ${str(a, 'path')}`;
		case 'list_dir': return `List ${str(a, 'path') || '.'}`;
		case 'glob': return `Find ${str(a, 'pattern')}`;
		case 'grep': return `Search "${str(a, 'pattern')}"`;
		case 'get_diagnostics': return `Diagnostics ${str(a, 'path') || '(workspace)'}`;
		case 'write_file': return `Write ${str(a, 'path')}`;
		case 'edit_file': return `Edit ${str(a, 'path')}`;
		case 'run_command': return `Run ${str(a, 'command')}`;
		case 'explore': return `Explore: ${str(a, 'description')}`;
		case 'delegate': return `Delegate: ${str(a, 'description')}`;
		default: return call.name;
	}
}

function StatusIcon({ status }: { status: ToolStatus }) {
	switch (status) {
		case 'pending':
		case 'running':
			return <Codicon name="loading" spin title={status === 'pending' ? 'Queued' : 'Running'} />;
		case 'awaitingApproval':
			return <Codicon name="question" title="Waiting for your approval" />;
		case 'done':
			return <Codicon name="check" title="Done" />;
		case 'rejected':
			return <Codicon name="circle-slash" title="Rejected" />;
		default:
			return <Codicon name="error" title="Failed" />;
	}
}

function formatArgs(args: unknown): string {
	if (typeof args === 'string') {
		return args;
	}
	return JSON.stringify(args, (_k, v) => (typeof v === 'string' && v.length > MAX_ARG_CHARS ? `${v.slice(0, MAX_ARG_CHARS)}… (${v.length} chars)` : v), 2);
}

function tail(text: string, lines: number): string {
	const all = text.trimEnd().split('\n');
	return all.slice(-lines).join('\n');
}

export function ToolCallCard({ call }: { call: ToolCallView }) {
	const [open, setOpen] = useState(false);
	const title = call.summary ?? describe(call);
	const path = call.name !== 'run_command' ? str(call.args, 'path') : '';
	const live = call.name === 'run_command' && call.status === 'running' && !!call.output && !open;

	return (
		<div className={`tool-card status-${call.status}`}>
			<div className="tool-head">
				<button type="button" className="tool-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
					<span className="tool-chevron"><Codicon name="chevron-right" /></span>
					<Codicon name={TOOL_ICONS[call.name] ?? 'tools'} />
					<span className="tool-title" title={title}>{title}</span>
				</button>
				{path && <IconButton icon="go-to-file" title={`Open ${path}`} onClick={() => post({ type: 'openFile', path })} />}
				<span className="tool-status"><StatusIcon status={call.status} /></span>
			</div>
			{call.approval && call.status === 'awaitingApproval' && <ApprovalCard call={call} />}
			{live && <pre className="tool-output live">{tail(call.output!, LIVE_OUTPUT_LINES)}</pre>}
			{open && (
				<div className="tool-body">
					<div className="tool-section-label">Arguments</div>
					<pre>{formatArgs(call.args)}</pre>
					{call.output && (
						<>
							<div className="tool-section-label">Output</div>
							<pre className="tool-output">{call.output}</pre>
						</>
					)}
					{/* run_command already streamed its output above; other tools show what the model received. */}
					{call.detail && !(call.name === 'run_command' && call.output) && (
						<>
							<div className="tool-section-label">Result</div>
							<pre>{call.detail}</pre>
						</>
					)}
				</div>
			)}
		</div>
	);
}
