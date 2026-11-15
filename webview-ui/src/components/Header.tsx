import { useEffect, useState, type Dispatch } from 'react';
import { formatCost } from '../../../src/shared/format';
import type { Action, UiState } from '../store';
import { post } from '../vscodeApi';
import { Codicon, IconButton } from './common';
import { ModelPicker } from './ModelPicker';

function OverflowMenu({ onClose, hasApiKey }: { onClose: () => void; hasApiKey: boolean }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	const item = (icon: string, label: string, action: () => void) => (
		<button type="button" role="menuitem" className="menu-item" onClick={() => { action(); onClose(); }}>
			<Codicon name={icon} /> {label}
		</button>
	);
	return (
		<>
			<div className="popover-backdrop" onClick={onClose} />
			<div className="menu" role="menu">
				{item('key', hasApiKey ? 'Change API key' : 'Set API key', () => post({ type: 'requestApiKey' }))}
				{hasApiKey && item('trash', 'Clear API key', () => post({ type: 'clearApiKey' }))}
				{item('refresh', 'Refresh models', () => post({ type: 'refreshModels' }))}
				{item('settings-gear', 'Settings', () => post({ type: 'openSettings' }))}
			</div>
		</>
	);
}

export function Header({ state, dispatch }: { state: UiState; dispatch: Dispatch<Action> }) {
	const [menuOpen, setMenuOpen] = useState(false);
	const cost = state.session.totals.cost;
	const tokens = state.session.totals.promptTokens + state.session.totals.completionTokens;
	return (
		<header className="header">
			<ModelPicker
				models={state.models}
				selected={state.selectedModel}
				recent={state.recentModels}
				error={state.modelsError}
				defaultToolsOnly={state.showOnlyToolModels && state.mode !== 'chat'}
				mode={state.mode}
			/>
			<div className="header-actions">
				{cost > 0 && (
					<span className="session-cost" title={`This chat: ${tokens.toLocaleString()} tokens, ${formatCost(cost)}`}>
						{formatCost(cost)}
					</span>
				)}
				<IconButton icon="add" title="New chat" onClick={() => post({ type: 'newChat' })} />
				<IconButton
					icon="history"
					title="Chat history"
					active={state.view === 'history'}
					onClick={() => dispatch({ type: 'setView', view: state.view === 'history' ? 'chat' : 'history' })}
				/>
				<div className="menu-anchor">
					<IconButton icon="ellipsis" title="More actions" active={menuOpen} onClick={() => setMenuOpen(o => !o)} />
					{menuOpen && <OverflowMenu hasApiKey={state.hasApiKey} onClose={() => setMenuOpen(false)} />}
				</div>
			</div>
		</header>
	);
}
