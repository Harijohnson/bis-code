import { useEffect, useReducer } from 'react';
import type { ExtensionMessage } from '../../src/shared/protocol';
import { Codicon } from './components/common';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { History } from './components/History';
import { MessageList } from './components/MessageList';
import { Onboarding } from './components/Onboarding';
import { initialState, reducer } from './store';
import { post } from './vscodeApi';

export function App() {
	const [state, dispatch] = useReducer(reducer, initialState);

	useEffect(() => {
		const onMessage = (e: MessageEvent<ExtensionMessage>) => dispatch({ type: 'ext', msg: e.data });
		window.addEventListener('message', onMessage);
		// The extension owns all state; ask for it every time this webview is (re)created.
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	if (!state.ready) {
		return (
			<div className="loading" role="status">
				<Codicon name="loading" spin /> Loading…
			</div>
		);
	}

	if (!state.hasApiKey && state.session.items.length === 0) {
		return <Onboarding />;
	}

	return (
		<div className="app">
			<Header state={state} dispatch={dispatch} />
			{state.view === 'history'
				? <History sessions={state.sessions} currentId={state.session.id} onClose={() => dispatch({ type: 'setView', view: 'chat' })} />
				: <MessageList state={state} dispatch={dispatch} />}
			<Composer state={state} hidden={state.view !== 'chat'} />
		</div>
	);
}
