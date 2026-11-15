import { useLayoutEffect, useRef, type Dispatch } from 'react';
import type { Mode, TranscriptItem } from '../../../src/shared/protocol';
import type { Action, UiState } from '../store';
import { Codicon } from './common';
import { TranscriptItemView } from './Message';

const SUGGESTIONS = [
	'Explain how this project is structured',
	'Find and fix the bug in the active file',
	'Write tests for the selected code',
];

const MODE_HINT: Record<Mode, string> = {
	agent: 'Agent mode: reads, searches, edits files and runs commands. You approve each edit and command.',
	plan: 'Plan mode: read-only. The agent investigates and proposes a plan without changing anything.',
	chat: 'Chat mode: no tools. Works with any model.',
};

function Welcome({ mode, dispatch }: { mode: Mode; dispatch: Dispatch<Action> }) {
	return (
		<div className="welcome">
			<h3>What can I help you build?</h3>
			<p className="muted">{MODE_HINT[mode]}</p>
			<ul className="suggestions">
				{SUGGESTIONS.map(s => (
					<li key={s}>
						<button type="button" onClick={() => dispatch({ type: 'fillComposer', text: s })}>
							<Codicon name="sparkle" /> {s}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Errors and notices only get action buttons while they are the latest thing in the chat. */
function actionableId(items: TranscriptItem[]): string | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.kind === 'footer') {
			continue;
		}
		return item.kind === 'error' || item.kind === 'notice' ? item.id : undefined;
	}
	return undefined;
}

export function MessageList({ state, dispatch }: { state: UiState; dispatch: Dispatch<Action> }) {
	const ref = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const items = state.session.items;

	useLayoutEffect(() => {
		const el = ref.current;
		if (el && stickToBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [items, state.running]);

	if (items.length === 0) {
		return <div className="messages"><Welcome mode={state.mode} dispatch={dispatch} /></div>;
	}

	const last = items[items.length - 1];
	const streamingId = state.running && last.kind === 'assistant' ? last.id : undefined;
	const actionable = actionableId(items);

	return (
		<div
			className="messages"
			ref={ref}
			role="log"
			aria-live="polite"
			onScroll={() => {
				const el = ref.current!;
				stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			}}
		>
			{items.map(item => (
				<TranscriptItemView
					key={item.id}
					item={item}
					streaming={item.id === streamingId}
					actionable={item.id === actionable}
					running={state.running}
					models={state.models}
				/>
			))}
			{state.running && !streamingId && (
				<div className="typing" role="status"><Codicon name="loading" spin /> Working…</div>
			)}
		</div>
	);
}
