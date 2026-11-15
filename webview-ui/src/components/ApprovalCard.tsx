import { useState } from 'react';
import type { ApprovalDecision, ToolCallView } from '../../../src/shared/protocol';
import { post } from '../vscodeApi';

function DiffLines({ text }: { text: string }) {
	return (
		<pre className="diff-preview">
			{text.split('\n').map((line, i) => (
				<div key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-ctx'}>{line || ' '}</div>
			))}
		</pre>
	);
}

export function ApprovalCard({ call }: { call: ToolCallView }) {
	const [reason, setReason] = useState('');
	const approval = call.approval!;
	const send = (decision: ApprovalDecision) =>
		post({ type: 'approval', callId: call.callId, decision, reason: reason.trim() || undefined });

	const reasonInput = (
		<input
			className="approval-reason"
			value={reason}
			onChange={e => setReason(e.target.value)}
			onKeyDown={e => {
				if (e.key === 'Enter' && reason.trim()) {
					send('reject');
				}
			}}
			placeholder="Optional: tell the agent what to do instead, then Reject"
			aria-label="Reason for rejecting"
		/>
	);

	if (approval.kind === 'edit') {
		const [header, ...rest] = approval.preview.split('\n');
		return (
			<div className="approval" role="group" aria-label="Approve file edit">
				<div className="approval-header">{header}</div>
				{rest.length > 0 && <DiffLines text={rest.join('\n')} />}
				{reasonInput}
				<div className="approval-actions">
					<button type="button" className="primary" onClick={() => send('accept')}>Accept</button>
					<button type="button" className="secondary" onClick={() => send('reject')}>Reject</button>
					<button type="button" className="secondary" onClick={() => send('acceptAll')} title="Apply this and every later edit in this chat without asking">
						Accept all edits this session
					</button>
					<button type="button" className="link" onClick={() => post({ type: 'showDiff', callId: call.callId })}>Show diff</button>
				</div>
			</div>
		);
	}

	return (
		<div className="approval" role="group" aria-label="Approve command">
			<div className="approval-header">Run this command?</div>
			<pre className="command-preview">{approval.preview}</pre>
			{reasonInput}
			<div className="approval-actions">
				<button type="button" className="primary" onClick={() => send('accept')}>Run</button>
				<button type="button" className="secondary" onClick={() => send('reject')}>Reject</button>
				{approval.allowPrefix && (
					<button type="button" className="secondary" onClick={() => send('alwaysAllow')} title="Adds this prefix to bisCode.allowedCommands for this workspace">
						Always allow <code>{approval.allowPrefix}</code>
					</button>
				)}
			</div>
		</div>
	);
}
