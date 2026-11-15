import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { formatPrice, formatTokens, modelLabel, shortModelName } from '../../../src/shared/format';
import { matchesFilters, providersOf, searchModels, type ModelFilters } from '../../../src/shared/modelSearch';
import type { Mode, ModelInfo } from '../../../src/shared/protocol';
import { post } from '../vscodeApi';
import { Codicon, IconButton } from './common';

const MAX_ROWS = 300;

interface PickerProps {
	models: ModelInfo[];
	selected?: string;
	recent: string[];
	error?: string;
	defaultToolsOnly: boolean;
	mode: Mode;
}

type Row =
	| { kind: 'custom'; id: string }
	| { kind: 'model'; model: ModelInfo; section: 'recent' | 'all' };

function Badges({ model }: { model: ModelInfo }) {
	return (
		<span className="model-badges">
			{model.supportsTools && <span className="badge">tools</span>}
			{model.supportsVision && <span className="badge">vision</span>}
			{model.supportsReasoning && <span className="badge">reasoning</span>}
			{model.isFree && <span className="badge badge-free">free</span>}
		</span>
	);
}

function Chip({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: ReactNode }) {
	return (
		<button type="button" className={`chip-toggle${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick}>
			<Codicon name={icon} /> {children}
		</button>
	);
}

function Popover({ models, selected, recent, error, defaultToolsOnly, onClose }: PickerProps & { onClose: () => void }) {
	const [query, setQuery] = useState('');
	const [toolsOnly, setToolsOnly] = useState(defaultToolsOnly);
	const [freeOnly, setFreeOnly] = useState(false);
	const [visionOnly, setVisionOnly] = useState(false);
	const [provider, setProvider] = useState('');
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => inputRef.current?.focus(), []);

	const filters: ModelFilters = useMemo(
		() => ({ toolsOnly, freeOnly, visionOnly, provider: provider || undefined }),
		[toolsOnly, freeOnly, visionOnly, provider],
	);
	const providers = useMemo(() => providersOf(models), [models]);
	const results = useMemo(() => searchModels(models, query, filters), [models, query, filters]);

	const rows: Row[] = useMemo(() => {
		const q = query.trim();
		const out: Row[] = [];
		if (q.includes('/') && !models.some(m => m.id === q)) {
			out.push({ kind: 'custom', id: q });
		}
		if (!q) {
			for (const id of recent) {
				const m = models.find(x => x.id === id);
				if (m && matchesFilters(m, filters)) {
					out.push({ kind: 'model', model: m, section: 'recent' });
				}
			}
		}
		for (const m of results.slice(0, MAX_ROWS)) {
			out.push({ kind: 'model', model: m, section: 'all' });
		}
		return out;
	}, [query, models, recent, results, filters]);

	useEffect(() => setActive(0), [query, filters]);
	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}, [active]);

	const choose = (id: string) => {
		post({ type: 'selectModel', modelId: id });
		onClose();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActive(a => Math.min(rows.length - 1, a + 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActive(a => Math.max(0, a - 1));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const row = rows[active];
			if (row) {
				choose(row.kind === 'custom' ? row.id : row.model.id);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if (e.key.length === 1 && document.activeElement !== inputRef.current && !(e.target instanceof HTMLSelectElement)) {
			inputRef.current?.focus(); // typing anywhere goes to the search box
		}
	};

	let lastSection: string | undefined;
	return (
		<>
			<div className="popover-backdrop" onClick={onClose} />
			<div className="model-popover" role="dialog" aria-label="Select model" onKeyDown={onKeyDown}>
				<div className="model-search">
					<Codicon name="search" />
					<input
						ref={inputRef}
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search models or type an id…"
						aria-label="Search models"
						aria-controls="model-list"
						aria-activedescendant={rows[active] ? `model-row-${active}` : undefined}
					/>
					<IconButton icon="refresh" title="Refresh model list" onClick={() => post({ type: 'refreshModels' })} />
				</div>
				<div className="model-filters">
					<Chip active={toolsOnly} onClick={() => setToolsOnly(v => !v)} icon="tools">Tool-capable</Chip>
					<Chip active={freeOnly} onClick={() => setFreeOnly(v => !v)} icon="gift">Free</Chip>
					<Chip active={visionOnly} onClick={() => setVisionOnly(v => !v)} icon="eye">Vision</Chip>
					<select className="provider-select" value={provider} onChange={e => setProvider(e.target.value)} aria-label="Provider">
						<option value="">All providers</option>
						{providers.map(p => <option key={p} value={p}>{p}</option>)}
					</select>
				</div>
				{error && (
					<div className="model-error" role="alert">
						{error} <button type="button" className="link" onClick={() => post({ type: 'refreshModels' })}>Retry</button>
					</div>
				)}
				<div className="model-list" id="model-list" role="listbox" ref={listRef}>
					{rows.map((row, i) => {
						const section = row.kind === 'custom' ? 'custom' : row.section;
						const header = section !== lastSection && section !== 'custom'
							? <div className="model-section" key={`h-${section}`}>{section === 'recent' ? 'Recent' : query.trim() ? 'Results' : 'All models'}</div>
							: null;
						lastSection = section;
						const common = {
							id: `model-row-${i}`,
							'data-index': i,
							role: 'option',
							'aria-selected': i === active,
							onMouseMove: () => setActive(i),
							onMouseDown: (e: MouseEvent) => e.preventDefault(),
						};
						if (row.kind === 'custom') {
							return (
								<div key="custom" {...common} className={`model-row${i === active ? ' active' : ''}`} onClick={() => choose(row.id)}>
									<div className="model-row-top"><Codicon name="edit" /> <span className="model-name">Use model id “{row.id}”</span></div>
									<div className="model-row-meta">Not in the OpenRouter list; it will be sent as typed.</div>
								</div>
							);
						}
						const m = row.model;
						return [
							header,
							<div
								key={`${row.section}-${m.id}`}
								{...common}
								className={`model-row${i === active ? ' active' : ''}${m.id === selected ? ' selected' : ''}`}
								onClick={() => choose(m.id)}
								title={m.description || m.name}
							>
								<div className="model-row-top">
									<span className="model-name">{shortModelName(m.name)}</span>
									{m.id === selected && <Codicon name="check" />}
									<Badges model={m} />
								</div>
								<div className="model-row-meta">
									<span className="model-id">{m.id}</span>
									<span>{formatTokens(m.contextLength)}</span>
									<span>{formatPrice(m)}</span>
								</div>
							</div>,
						];
					})}
					{rows.length === 0 && (
						<div className="model-empty">
							{models.length === 0 && !error ? 'Loading models…' : 'No models match.'}
							{toolsOnly && models.length > 0 && ' Try turning off “Tool-capable”.'}
							<br />You can also type a full model id such as <code>vendor/model</code>.
						</div>
					)}
					{results.length > MAX_ROWS && (
						<div className="model-more">Showing {MAX_ROWS} of {results.length}. Keep typing to narrow the list.</div>
					)}
				</div>
			</div>
		</>
	);
}

export function ModelPicker(props: PickerProps) {
	const [open, setOpen] = useState(false);
	const info = props.models.find(m => m.id === props.selected);
	const noTools = info && !info.supportsTools && props.mode !== 'chat';
	return (
		<div className="model-picker">
			<button
				type="button"
				className="model-button"
				aria-haspopup="dialog"
				aria-expanded={open}
				title={props.selected ? `${props.selected} — change model` : 'Select a model'}
				onClick={() => setOpen(o => !o)}
			>
				<Codicon name="chevron-down" />
				<span className="model-button-label">{modelLabel(props.selected, props.models)}</span>
				{noTools && <Codicon name="warning" title="This model can't use tools. Use Chat mode or pick a tool-capable model." />}
			</button>
			{open && <Popover {...props} onClose={() => setOpen(false)} />}
		</div>
	);
}
