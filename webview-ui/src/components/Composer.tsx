import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Mode } from '../../../src/shared/protocol';
import type { UiState } from '../store';
import { loadPersisted, post, savePersisted } from '../vscodeApi';
import { Codicon } from './common';

const MAX_HEIGHT = 240;

export function Composer({ state, hidden }: { state: UiState; hidden: boolean }) {
	const [text, setText] = useState(() => loadPersisted().draft ?? '');
	const [includeContext, setIncludeContext] = useState(true);
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => savePersisted({ draft: text }), [text]);

	// A new active file brings the context chip back.
	useEffect(() => setIncludeContext(true), [state.activeContext?.path]);

	// The reducer creates a new `composerInject` object only for a new injection.
	const inject = state.composerInject;
	useEffect(() => {
		if (!inject) {
			return;
		}
		setText(current => (inject.replace || !current.trim() ? inject.text : `${current.replace(/\s*$/, '')}\n\n${inject.text}`));
		ref.current?.focus();
	}, [inject]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (el) {
			el.style.height = 'auto';
			el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
		}
	}, [text, hidden]);

	const canSend = !!text.trim() && state.hasApiKey && !!state.selectedModel && !state.running;
	const send = () => {
		if (!canSend) {
			return;
		}
		post({ type: 'sendMessage', text, includeActiveFile: includeContext && !!state.activeContext });
		setText('');
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			send();
		} else if (e.key === 'Escape' && state.running) {
			e.preventDefault();
			post({ type: 'stop' });
		}
	};

	const ctx = state.activeContext;
	return (
		<div className="composer" hidden={hidden}>
			{ctx && includeContext && (
				<div className="context-chips">
					<span className="chip" title={ctx.hasSelection ? `Selection in ${ctx.path} will be attached` : `${ctx.path} will be mentioned`}>
						<Codicon name={ctx.hasSelection ? 'selection' : 'file'} />
						<span className="chip-label">{ctx.label}</span>
						<button type="button" aria-label="Don't attach the active file" onClick={() => setIncludeContext(false)}>
							<Codicon name="close" />
						</button>
					</span>
				</div>
			)}
			<textarea
				ref={ref}
				rows={1}
				value={text}
				onChange={e => setText(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={state.running ? 'Working… (Esc to stop)' : 'Ask bis-code… (Enter to send, Shift+Enter for a new line)'}
				aria-label="Message"
			/>
			<div className="composer-bar">
				<select
					className="mode-select"
					value={state.mode}
					onChange={e => post({ type: 'setMode', mode: e.target.value as Mode })}
					aria-label="Mode"
					title="Agent: full tools · Plan: read-only · Chat: no tools"
				>
					<option value="agent">Agent</option>
					<option value="plan">Plan</option>
					<option value="chat">Chat</option>
				</select>
				{state.mode === 'agent' && state.trusted && (
					<label className="toggle" title="Apply file edits without asking (commands still ask)">
						<input type="checkbox" checked={state.autoEdit} onChange={e => post({ type: 'setAutoEdit', value: e.target.checked })} />
						Auto-edit
					</label>
				)}
				{!state.trusted && (
					<button
						type="button"
						className="restricted"
						onClick={() => post({ type: 'requestTrust' })}
						title="Restricted Mode: bis-code asks you to trust this workspace before it edits files or runs commands. Click to manage workspace trust."
					>
						<Codicon name="workspace-untrusted" /> Restricted
					</button>
				)}
				<span className="spacer" />
				{state.running
					? (
						<button type="button" className="send-button stop" onClick={() => post({ type: 'stop' })} title="Stop (Esc)" aria-label="Stop">
							<Codicon name="debug-stop" />
						</button>
					)
					: (
						<button type="button" className="send-button" disabled={!canSend} onClick={send} title="Send (Enter)" aria-label="Send">
							<Codicon name="send" />
						</button>
					)}
			</div>
			{!state.hasApiKey && (
				<div className="composer-hint">
					Connect OpenRouter to continue. <button type="button" className="link" onClick={() => post({ type: 'requestApiKey' })}>Set API key</button>
				</div>
			)}
			{state.hasApiKey && !state.selectedModel && <div className="composer-hint">Pick a model above to start.</div>}
		</div>
	);
}
