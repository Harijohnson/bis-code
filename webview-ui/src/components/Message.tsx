import { formatCost, shortModelName } from '../../../src/shared/format';
import { splitMentions } from '../../../src/shared/mentionSearch';
import type { AgentTag, ModelInfo, TranscriptItem, Usage } from '../../../src/shared/protocol';
import { useSmoothText } from '../useSmoothText';
import { post } from '../vscodeApi';
import { Codicon, ExternalLink, TypingDots } from './common';
import { Markdown } from './Markdown';
import { ConnectCard } from './Onboarding';
import { ToolCallCard } from './ToolCallCard';

type Item<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

function compact(n: number): string {
	return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function UserMessage({ item }: { item: Item<'user'> }) {
	return (
		<div className="user-message">
			<div className="user-bubble">
				{splitMentions(item.text, item.mentions ?? []).map((seg, i) => {
					if (!seg.mention) {
						return <span key={i}>{seg.text}</span>;
					}
					const isFolder = seg.mention.endsWith('/');
					return isFolder
						? <span key={i} className="mention-token" title={seg.mention}>{seg.text}</span>
						: (
							<button key={i} type="button" className="mention-token" title={`Open ${seg.mention}`} onClick={() => post({ type: 'openFile', path: seg.mention! })}>
								{seg.text}
							</button>
						);
				})}
			</div>
			{item.contextLabel && (
				<div className="user-context"><Codicon name="file" /> {item.contextLabel}</div>
			)}
		</div>
	);
}

function SubagentLabel({ tag }: { tag: AgentTag }) {
	const explore = tag.kind === 'explore';
	return (
		<div className="subagent-label" title={explore ? 'Read-only sub-agent' : 'Sub-agent that can edit files and run commands'}>
			<Codicon name={explore ? 'telescope' : 'robot'} />
			<span className="subagent-kind">{explore ? 'Explore' : 'Delegate'}</span>
			<span className="subagent-task">{tag.label}</span>
		</div>
	);
}

function AssistantMessage({ item, streaming }: { item: Item<'assistant'>; streaming: boolean }) {
	const empty = !item.text && !item.reasoning && item.toolCalls.length === 0;
	const text = useSmoothText(item.text, streaming);
	return (
		<div className={item.agent ? 'assistant-message subagent' : 'assistant-message'}>
			{item.agent && <SubagentLabel tag={item.agent} />}
			{item.reasoning && (
				<details className="reasoning" open={streaming && !item.text && item.toolCalls.length === 0}>
					<summary><Codicon name="lightbulb" /> Thinking</summary>
					<div className="reasoning-text">{item.reasoning}</div>
				</details>
			)}
			{text && <Markdown text={text} streaming={streaming && item.toolCalls.length === 0} />}
			{streaming && empty && <TypingDots label="Thinking" />}
			{item.toolCalls.map(c => <ToolCallCard key={c.callId} call={c} />)}
		</div>
	);
}

function TurnFooter({ item, models }: { item: Item<'footer'>; models: ModelInfo[] }) {
	const name = models.find(m => m.id === item.model)?.name;
	const u: Usage | undefined = item.usage;
	return (
		<div className="turn-footer" title={item.model}>
			<span>{name ? shortModelName(name) : item.model}</span>
			{u && <span>{compact(u.promptTokens)} in · {compact(u.completionTokens)} out</span>}
			{item.cost !== undefined && <span>{formatCost(item.cost)}</span>}
			{item.stopped && <span className="stopped">stopped</span>}
		</div>
	);
}

function ErrorCard({ item, actionable, running }: { item: Item<'error'>; actionable: boolean; running: boolean }) {
	if (item.code === 'auth') {
		return (
			<div className="error-card auth">
				<ConnectCard message={item.message} />
				{actionable && item.retryable && (
					<div className="error-actions">
						<button type="button" className="secondary" disabled={running} onClick={() => post({ type: 'retry' })}>Retry</button>
					</div>
				)}
			</div>
		);
	}
	const toolsUnsupported = item.code === 'model' && /can't use tools/i.test(item.message);
	return (
		<div className="error-card" role="alert">
			<div className="error-title"><Codicon name="error" /> {item.code === 'credits' ? 'Out of credits' : item.code === 'rateLimit' ? 'Rate limited' : 'Request failed'}</div>
			<div className="error-message">{item.message}</div>
			{actionable && (
				<div className="error-actions">
					{item.code === 'credits' && <ExternalLink href="https://openrouter.ai/credits">Add credits</ExternalLink>}
					{toolsUnsupported && (
						<button type="button" className="secondary" onClick={() => post({ type: 'setMode', mode: 'chat' })}>Switch to Chat mode</button>
					)}
					{(item.retryable || item.code === 'credits') && (
						<button type="button" className="secondary" disabled={running} onClick={() => post({ type: 'retry' })}>Retry</button>
					)}
				</div>
			)}
		</div>
	);
}

function Notice({ item, actionable, running }: { item: Item<'notice'>; actionable: boolean; running: boolean }) {
	return (
		<div className="notice">
			<Codicon name="info" /> <span>{item.text}</span>
			{item.action === 'continue' && actionable && (
				<button type="button" className="secondary" disabled={running} onClick={() => post({ type: 'continue' })}>Continue</button>
			)}
		</div>
	);
}

export function TranscriptItemView(props: { item: TranscriptItem; streaming: boolean; actionable: boolean; running: boolean; models: ModelInfo[] }) {
	const { item } = props;
	switch (item.kind) {
		case 'user':
			return <UserMessage item={item} />;
		case 'assistant':
			return <AssistantMessage item={item} streaming={props.streaming} />;
		case 'footer':
			return <TurnFooter item={item} models={props.models} />;
		case 'divider':
			return <div className="divider" role="separator"><span>{item.text}</span></div>;
		case 'notice':
			return <Notice item={item} actionable={props.actionable} running={props.running} />;
		case 'error':
			return <ErrorCard item={item} actionable={props.actionable} running={props.running} />;
	}
}
