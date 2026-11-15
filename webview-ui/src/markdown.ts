import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const marked = new Marked({ gfm: true, breaks: false, async: false });

marked.use({
	renderer: {
		code({ text, lang }: Tokens.Code): string {
			const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
			let body = escapeHtml(text);
			if (language && hljs.getLanguage(language)) {
				try {
					body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
				} catch {
					// fall back to plain text
				}
			}
			return `<div class="code-block">`
				+ `<div class="code-toolbar"><span class="code-lang">${escapeHtml(language)}</span>`
				+ `<button class="code-btn" data-action="copy" title="Copy" aria-label="Copy code"><i class="codicon codicon-copy"></i></button>`
				+ `<button class="code-btn" data-action="insert" title="Insert at cursor" aria-label="Insert code at cursor"><i class="codicon codicon-insert"></i></button>`
				+ `</div><pre><code class="hljs">${body}</code></pre></div>`;
		},
	},
});

/** Renders model output. Everything goes through DOMPurify; nothing is ever evaluated. */
export function renderMarkdown(src: string): string {
	const html = marked.parse(src) as string;
	return DOMPurify.sanitize(html, {
		FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'iframe', 'object', 'embed'],
		FORBID_ATTR: ['style'],
	});
}
