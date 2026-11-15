import { isTranscriptEvent, type AppState, type ExtensionMessage } from '../../src/shared/protocol';
import { applyTranscriptEvent } from '../../src/shared/transcript';

export type View = 'chat' | 'history';

export interface UiState extends AppState {
	ready: boolean;
	view: View;
	/** Text pushed into the composer by the extension (insertText / restoreDraft). */
	composerInject?: { text: string; replace: boolean; seq: number };
}

export const initialState: UiState = {
	ready: false,
	view: 'chat',
	hasApiKey: false,
	models: [],
	modelsStale: false,
	recentModels: [],
	mode: 'agent',
	autoEdit: false,
	running: false,
	session: { id: '', title: '', items: [], totals: { promptTokens: 0, completionTokens: 0, cost: 0 } },
	sessions: [],
	trusted: true,
	showOnlyToolModels: true,
};

export type Action =
	| { type: 'ext'; msg: ExtensionMessage }
	| { type: 'setView'; view: View }
	| { type: 'fillComposer'; text: string };

function inject(state: UiState, text: string, replace: boolean): UiState {
	return { ...state, view: 'chat', composerInject: { text, replace, seq: (state.composerInject?.seq ?? 0) + 1 } };
}

export function reducer(state: UiState, action: Action): UiState {
	if (action.type === 'setView') {
		return { ...state, view: action.view };
	}
	if (action.type === 'fillComposer') {
		return inject(state, action.text, true);
	}
	const msg = action.msg;
	if (isTranscriptEvent(msg)) {
		return { ...state, session: { ...state.session, items: applyTranscriptEvent(state.session.items, msg) } };
	}
	switch (msg.type) {
		case 'state':
			return {
				...state,
				...msg.state,
				ready: true,
				// Loading or starting a chat returns to the transcript.
				view: msg.state.session.id !== state.session.id ? 'chat' : state.view,
			};
		case 'models':
			return { ...state, models: msg.models, modelsStale: msg.stale, modelsError: msg.error };
		case 'apiKey':
			return { ...state, hasApiKey: msg.hasApiKey };
		case 'selectedModel':
			return { ...state, selectedModel: msg.modelId, recentModels: msg.recentModels };
		case 'mode':
			return { ...state, mode: msg.mode };
		case 'autoEdit':
			return { ...state, autoEdit: msg.value };
		case 'running':
			return { ...state, running: msg.running };
		case 'trust':
			return { ...state, trusted: msg.trusted };
		case 'sessions':
			return { ...state, sessions: msg.sessions, session: { ...state.session, totals: msg.totals, title: msg.title } };
		case 'activeContext':
			return { ...state, activeContext: msg.context };
		case 'insertText':
			return inject(state, msg.text, false);
		case 'restoreDraft':
			return inject(state, msg.text, true);
		default:
			return state;
	}
}
