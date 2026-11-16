import { memo, useMemo, type MouseEvent } from 'react';
import { renderMarkdown } from '../markdown';
import { post } from '../vscodeApi';

function onClick(e: MouseEvent<HTMLDivElement>) {
	const target = e.target as HTMLElement;
	const button = target.closest<HTMLButtonElement>('button[data-action]');
	if (button) {
		const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
		if (button.dataset.action === 'copy') {
			void navigator.clipboard.writeText(code).then(() => {
				button.classList.add('done');
				setTimeout(() => button.classList.remove('done'), 1200);
			});
		} else if (button.dataset.action === 'insert') {
			post({ type: 'insertCode', code });
		}
		return;
	}
	const link = target.closest('a');
	if (link) {
		e.preventDefault();
		const href = link.getAttribute('href') ?? '';
		if (/^(https?:|mailto:)/i.test(href)) {
			post({ type: 'openExternal', url: href });
		} else if (href && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
			// Relative links in model output are usually workspace paths, e.g. src/a.ts#L10
			const [path, line] = href.split('#L');
			post({ type: 'openFile', path: decodeURIComponent(path), line: line ? Number(line) : undefined });
		}
	}
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className={`markdown${streaming ? ' streaming' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
