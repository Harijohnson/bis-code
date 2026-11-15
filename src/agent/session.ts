import * as vscode from 'vscode';
import type { ChatMessage } from '../openrouter/types';
import type { SessionSummary, SessionTotals, SessionView, TranscriptItem } from '../shared/protocol';
import { settleTranscript } from '../shared/transcript';
import { newId } from '../util/text';

export const MAX_SESSIONS = 100;
const TITLE_CHARS = 60;

export interface Session {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	modelHistory: string[];
	/** Conversation in OpenAI format (what the model sees). Compaction rewrites it. */
	messages: ChatMessage[];
	/** What the UI shows. Never compacted. */
	transcript: TranscriptItem[];
	/** Normalized absolute path → mtime when the agent last read it. */
	readFiles: Record<string, number>;
	totals: SessionTotals;
	/** Measured chars-per-token ratio, used to correct the estimate. */
	charsPerToken?: number;
}

export function createSession(): Session {
	const now = Date.now();
	return {
		id: newId('s'),
		title: 'New chat',
		createdAt: now,
		updatedAt: now,
		modelHistory: [],
		messages: [],
		transcript: [],
		readFiles: {},
		totals: { promptTokens: 0, completionTokens: 0, cost: 0 },
	};
}

export function titleFrom(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > TITLE_CHARS ? oneLine.slice(0, TITLE_CHARS - 1) + '…' : oneLine || 'New chat';
}

export function toView(s: Session): SessionView {
	return { id: s.id, title: s.title, items: s.transcript, totals: s.totals };
}

function toSummary(s: Session): SessionSummary {
	return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, cost: s.totals.cost };
}

/**
 * Persists sessions as JSON under `<storage>/sessions/<id>.json` with an `index.json`
 * listing. Keeps the newest MAX_SESSIONS.
 */
export class SessionManager {
	private index: SessionSummary[] = [];
	private writes: Promise<void> = Promise.resolve();
	current: Session = createSession();

	constructor(private readonly dir: vscode.Uri) { }

	private fileFor(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
	}

	private get indexUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.dir, 'index.json');
	}

	async init(): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.dir);
			const raw = await vscode.workspace.fs.readFile(this.indexUri);
			const parsed = JSON.parse(new TextDecoder().decode(raw)) as SessionSummary[];
			this.index = Array.isArray(parsed) ? parsed.filter(s => s && typeof s.id === 'string') : [];
		} catch {
			this.index = [];
		}
	}

	list(): SessionSummary[] {
		return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	newSession(): Session {
		this.current = createSession();
		return this.current;
	}

	async load(id: string): Promise<Session | undefined> {
		try {
			const raw = await vscode.workspace.fs.readFile(this.fileFor(id));
			const s = JSON.parse(new TextDecoder().decode(raw)) as Session;
			s.transcript = settleTranscript(s.transcript ?? []);
			s.readFiles ??= {};
			s.modelHistory ??= [];
			s.totals ??= { promptTokens: 0, completionTokens: 0, cost: 0 };
			this.current = s;
			return s;
		} catch {
			// The file is gone or corrupt; drop it from the index.
			this.index = this.index.filter(x => x.id !== id);
			await this.writeIndex().catch(() => undefined);
			return undefined;
		}
	}

	/** Saves a session (skipped while it is still empty). Writes are serialized. */
	save(session: Session): Promise<void> {
		if (session.messages.length === 0 && session.transcript.length === 0) {
			return this.writes;
		}
		const json = JSON.stringify(session);
		const summary = toSummary(session);
		this.writes = this.writes.then(async () => {
			try {
				await vscode.workspace.fs.createDirectory(this.dir);
				await vscode.workspace.fs.writeFile(this.fileFor(session.id), new TextEncoder().encode(json));
				this.index = [summary, ...this.index.filter(x => x.id !== session.id)];
				await this.prune();
				await this.writeIndex();
			} catch (err) {
				console.error('[bis-code] failed to save session', err);
			}
		});
		return this.writes;
	}

	async delete(id: string): Promise<void> {
		this.index = this.index.filter(x => x.id !== id);
		this.writes = this.writes.then(async () => {
			await vscode.workspace.fs.delete(this.fileFor(id)).then(undefined, () => undefined);
			await this.writeIndex().catch(err => console.error('[bis-code] failed to update session index', err));
		});
		await this.writes;
		if (this.current.id === id) {
			this.newSession();
		}
	}

	private async prune(): Promise<void> {
		const sorted = this.list();
		const drop = sorted.slice(MAX_SESSIONS);
		if (!drop.length) {
			return;
		}
		this.index = sorted.slice(0, MAX_SESSIONS);
		for (const s of drop) {
			await vscode.workspace.fs.delete(this.fileFor(s.id)).then(undefined, () => undefined);
		}
	}

	private async writeIndex(): Promise<void> {
		await vscode.workspace.fs.writeFile(this.indexUri, new TextEncoder().encode(JSON.stringify(this.index)));
	}

	flush(): Promise<void> {
		return this.writes;
	}
}
