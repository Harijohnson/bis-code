import { useEffect, useRef } from 'react';
import { baseName, fuzzyMatch } from '../../../src/shared/mentionSearch';
import type { MentionItem } from '../../../src/shared/protocol';
import { Codicon } from './common';

/** The file name with the characters that matched the query highlighted. */
function Highlighted({ item, query }: { item: MentionItem; query: string }) {
	const name = baseName(item.path);
	const nameStart = item.path.length - name.length - (item.kind === 'folder' ? 1 : 0);
	const hits = new Set((fuzzyMatch(query, item.path)?.positions ?? []).map(p => p - nameStart));
	if (hits.size === 0) {
		return <>{name}</>;
	}
	return (
		<>
			{[...name].map((ch, i) => (hits.has(i) ? <mark key={i}>{ch}</mark> : ch))}
		</>
	);
}

function parentOf(item: MentionItem): string {
	const trimmed = item.path.replace(/\/$/, '');
	const slash = trimmed.lastIndexOf('/');
	return slash >= 0 ? trimmed.slice(0, slash) : '';
}

export function MentionPicker(props: {
	items: MentionItem[];
	query: string;
	active: number;
	loading: boolean;
	onHover: (index: number) => void;
	onChoose: (item: MentionItem, drill: boolean) => void;
}) {
	const { items, query, active, loading } = props;
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}, [active, items]);

	return (
		<div className="mention-picker" role="dialog" aria-label="Mention a file or folder" onMouseDown={e => e.preventDefault()}>
			<div className="mention-head">
				<span><Codicon name="mention" /> Files &amp; folders</span>
				<span className="mention-keys"><kbd>↑↓</kbd> <kbd>Enter</kbd> add <kbd>Tab</kbd> open folder <kbd>Esc</kbd></span>
			</div>
			{items.length === 0
				? (
					<div className="mention-empty">
						{loading ? <><Codicon name="loading" spin /> Searching…</> : query ? `No files match "${query}"` : 'No files in this workspace'}
					</div>
				)
				: (
					<ul className="mention-list" role="listbox" ref={listRef}>
						{items.map((item, i) => (
							<li
								key={item.path}
								data-index={i}
								role="option"
								aria-selected={i === active}
								className={`mention-row${i === active ? ' active' : ''}`}
								onMouseMove={() => i !== active && props.onHover(i)}
								onClick={() => props.onChoose(item, false)}
								title={item.path}
							>
								<Codicon name={item.kind === 'folder' ? 'folder' : 'file'} />
								<span className="mention-name"><Highlighted item={item} query={query} /></span>
								<span className="mention-dir">{parentOf(item)}</span>
								{item.kind === 'folder' && (
									<button
										type="button"
										className="mention-drill"
										title="Show files in this folder (Tab)"
										aria-label={`Show files in ${item.path}`}
										onClick={e => {
											e.stopPropagation();
											props.onChoose(item, true);
										}}
									>
										<Codicon name="chevron-right" />
									</button>
								)}
							</li>
						))}
					</ul>
				)}
		</div>
	);
}
