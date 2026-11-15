import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { activeMentions, baseName, findMentionQuery, splitMentions } from '../../../src/shared/mentionSearch';
import type { MentionItem, Mode } from '../../../src/shared/protocol';
import type { UiState } from '../store';
import { loadPersisted, post, savePersisted } from '../vscodeApi';
import { Codicon } from './common';
import { MentionPicker } from './MentionPicker';

const MAX_HEIGHT = 240;
const SEARCH_DEBOUNCE_MS = 60;
const MAX_REMEMBERED_MENTIONS = 50;

export function Composer({ state, hidden }: { state: UiState; hidden: boolean }) {
	const [text, setText] = useState(() => loadPersisted().draft ?? '');
	/** Paths picked from the mention menu. Only those still written as `@path` in the text are sent. */
	const [mentions, setMentions] = useState<string[]>(() => loadPersisted().mentions ?? []);
	const [includeContext, setIncludeContext] = useState(true);
	const [caret, setCaret] = useState(0);
	const [dismissedAt, setDismissedAt] = useState<number>();
	const [activeIndex, setActiveIndex] = useState(0);
	const [items, setItems] = useState<MentionItem[]>([]);
	const [loading, setLoading] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const backdropRef = useRef<HTMLDivElement>(null);
	const requestId = useRef(0);
	const pendingCaret = useRef<number | undefined>(undefined);

	useEffect(() => savePersisted({ draft: text, mentions: mentions.slice(-MAX_REMEMBERED_MENTIONS) }), [text, mentions]);

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
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
		if (pendingCaret.current !== undefined) {
			el.setSelectionRange(pendingCaret.current, pendingCaret.current);
			setCaret(pendingCaret.current);
			pendingCaret.current = undefined;
		}
		if (backdropRef.current) {
			backdropRef.current.scrollTop = el.scrollTop;
		}
	}, [text, hidden]);

	// ── @-mention menu ───────────────────────────────────────────────────────
	const found = findMentionQuery(text, caret);
	const menu = found && found.start !== dismissedAt ? found : undefined;
	const query = menu?.query;

	useEffect(() => {
		if (query === undefined) {
			return;
		}
		setLoading(true);
		const id = ++requestId.current;
		const timer = setTimeout(() => post({ type: 'searchMentions', requestId: id, query }), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);

	const results = state.mentionResults;
	useEffect(() => {
		if (results && results.requestId === requestId.current) {
			setItems(results.items);
			setActiveIndex(0);
			setLoading(false);
		}
	}, [results]);

	const replaceRange = (start: number, end: number, insert: string) => {
		pendingCaret.current = start + insert.length;
		setText(text.slice(0, start) + insert + text.slice(end));
		ref.current?.focus();
	};

	const choose = (item: MentionItem, drill: boolean) => {
		if (!menu) {
			return;
		}
		if (drill && item.kind === 'folder') {
			replaceRange(menu.start, caret, `@${item.path}`);
			return;
		}
		replaceRange(menu.start, caret, `@${item.path} `);
		setMentions(m => [...m.filter(p => p !== item.path), item.path]);
	};

	const removeMention = (path: string) => {
		const segments = splitMentions(text, [path]);
		const at = segments.findIndex(s => s.mention);
		if (at < 0) {
			return;
		}
		const before = segments.slice(0, at).map(s => s.text).join('');
		let after = segments.slice(at + 1).map(s => s.text).join('');
		if ((before === '' || /\s$/.test(before)) && after.startsWith(' ')) {
			after = after.slice(1);
		}
		setText(before + after);
		ref.current?.focus();
	};

	const insertAt = () => {
		const el = ref.current;
		const pos = el?.selectionStart ?? text.length;
		const needsSpace = pos > 0 && !/\s/.test(text[pos - 1]);
		setDismissedAt(undefined);
		replaceRange(pos, el?.selectionEnd ?? pos, needsSpace ? ' @' : '@');
	};

	// ── Sending ──────────────────────────────────────────────────────────────
	const sent = activeMentions(text, mentions);
	const canSend = !!text.trim() && state.hasApiKey && !!state.selectedModel && !state.running;
	const send = () => {
		if (!canSend) {
			return;
		}
		post({ type: 'sendMessage', text, includeActiveFile: includeContext && !!state.activeContext, mentions: sent });
		setText('');
		setDismissedAt(undefined);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) {
			return;
		}
		if (menu && items.length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				setActiveIndex(i => (i + step + items.length) % items.length);
				return;
			}
			if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
				e.preventDefault();
				choose(items[Math.min(activeIndex, items.length - 1)], e.key === 'Tab');
				return;
			}
		}
		if (menu && e.key === 'Escape') {
			e.preventDefault();
			setDismissedAt(menu.start);
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		} else if (e.key === 'Escape' && state.running) {
			e.preventDefault();
			post({ type: 'stop' });
		}
	};

	const ctx = state.activeContext;
	const showChips = sent.length > 0 || (ctx && includeContext);
	return (
		<div className="composer" hidden={hidden}>
			{menu && (
				<MentionPicker
					items={items}
					query={menu.query}
					active={activeIndex}
					loading={loading}
					onHover={setActiveIndex}
					onChoose={choose}
				/>
			)}
			{showChips && (
				<div className="context-chips">
					{ctx && includeContext && (
						<span className="chip chip-context" title={ctx.hasSelection ? `Selection in ${ctx.path} will be attached` : `${ctx.path} will be mentioned`}>
							<Codicon name={ctx.hasSelection ? 'selection' : 'file'} />
							<span className="chip-label">{ctx.label}</span>
							<button type="button" aria-label="Don't attach the active file" onClick={() => setIncludeContext(false)}>
								<Codicon name="close" />
							</button>
						</span>
					)}
					{sent.map(path => (
						<span key={path} className="chip chip-mention" title={path.endsWith('/') ? `Listing of ${path} will be attached` : `${path} will be attached`}>
							<Codicon name={path.endsWith('/') ? 'folder' : 'file'} />
							<span className="chip-label">{baseName(path)}</span>
							<button type="button" aria-label={`Remove ${path}`} onClick={() => removeMention(path)}>
								<Codicon name="close" />
							</button>
						</span>
					))}
				</div>
			)}
			<div className="composer-input">
				<div className="composer-backdrop" ref={backdropRef} aria-hidden>
					{splitMentions(text, sent).map((seg, i) => (seg.mention ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))}
					{'​'}
				</div>
				<textarea
					ref={ref}
					rows={1}
					value={text}
					onChange={e => {
						setText(e.target.value);
						setCaret(e.target.selectionStart);
					}}
					onSelect={e => setCaret(e.currentTarget.selectionStart)}
					onScroll={e => {
						if (backdropRef.current) {
							backdropRef.current.scrollTop = e.currentTarget.scrollTop;
						}
					}}
					onBlur={() => menu && setDismissedAt(menu.start)}
					onFocus={() => setDismissedAt(undefined)}
					onKeyDown={onKeyDown}
					placeholder={state.running ? 'Working… (Esc to stop)' : 'Ask bis-code… (@ to mention files, Enter to send)'}
					aria-label="Message"
					aria-autocomplete="list"
					aria-expanded={!!menu}
				/>
			</div>
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
				<button type="button" className="icon-button" title="Mention a file or folder (@)" aria-label="Mention a file or folder" onClick={insertAt}>
					<Codicon name="mention" />
				</button>
				{state.mode === 'agent' && state.trusted && (
					<label className="toggle" title="Apply file edits without asking (commands still ask)">
						<input type="checkbox" checked={state.autoEdit} onChange={e => post({ type: 'setAutoEdit', value: e.target.checked })} />
						Auto-edit
					</label>
				)}
				{!state.trusted && (
					<span className="muted restricted" title="Untrusted workspace: edits and commands are disabled">
						<Codicon name="shield" /> Restricted
					</span>
				)}
				<span className="spacer" />
				{state.running
					? (
						<button type="button" className="send-button stop" onClick={() => post({ type: 'stop' })} title="Stop (Esc)" aria-label="Stop">
							<Codicon name="debug-stop" />
						</button>
					)
					: (
						<button type="button" className={`send-button${canSend ? ' ready' : ''}`} disabled={!canSend} onClick={send} title="Send (Enter)" aria-label="Send">
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
