import { formatCost } from '../../../src/shared/format';
import type { SessionSummary } from '../../../src/shared/protocol';
import { post } from '../vscodeApi';
import { IconButton } from './common';

function formatWhen(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function History({ sessions, currentId, onClose }: { sessions: SessionSummary[]; currentId: string; onClose: () => void }) {
	return (
		<div className="history">
			<div className="history-head">
				<span>Chat history</span>
				<IconButton icon="close" title="Back to chat" onClick={onClose} />
			</div>
			{sessions.length === 0
				? <div className="history-empty">No saved chats yet.</div>
				: (
					<ul className="history-list">
						{sessions.map(s => (
							<li key={s.id} className={s.id === currentId ? 'current' : undefined}>
								<button type="button" className="history-item" onClick={() => (s.id === currentId ? onClose() : post({ type: 'loadSession', id: s.id }))}>
									<span className="history-title">{s.title}</span>
									<span className="history-meta">
										{formatWhen(s.updatedAt)}{s.cost > 0 ? ` · ${formatCost(s.cost)}` : ''}
									</span>
								</button>
								<IconButton icon="trash" title={`Delete "${s.title}"`} onClick={() => post({ type: 'deleteSession', id: s.id })} />
							</li>
						))}
					</ul>
				)}
		</div>
	);
}
