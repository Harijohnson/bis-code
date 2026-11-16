import type { MouseEvent, ReactNode } from 'react';
import { post } from '../vscodeApi';

export function Codicon({ name, spin, title }: { name: string; spin?: boolean; title?: string }) {
	return (
		<i
			className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`}
			aria-hidden={title ? undefined : true}
			aria-label={title}
			title={title}
		/>
	);
}

/** Three pulsing dots, shown while waiting for the model. */
export function TypingDots({ label }: { label: string }) {
	return (
		<div className="typing" role="status">
			<span className="typing-dots" aria-hidden><i /><i /><i /></span>
			<span>{label}…</span>
		</div>
	);
}

export function IconButton(props: { icon: string; title: string; onClick: (e: MouseEvent) => void; active?: boolean; disabled?: boolean }) {
	return (
		<button
			type="button"
			className={`icon-button${props.active ? ' active' : ''}`}
			title={props.title}
			aria-label={props.title}
			aria-pressed={props.active}
			disabled={props.disabled}
			onClick={props.onClick}
		>
			<Codicon name={props.icon} />
		</button>
	);
}

/** An anchor that opens through the extension (which checks the scheme) instead of navigating the webview. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			onClick={e => {
				e.preventDefault();
				post({ type: 'openExternal', url: href });
			}}
		>
			{children}
		</a>
	);
}
