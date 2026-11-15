import type { WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(msg: WebviewMessage): void {
	api.postMessage(msg);
}

/** Per-view UI conveniences that survive the webview being hidden (not app state). */
interface Persisted {
	draft?: string;
	/** Paths picked from the @-mention menu for the draft. */
	mentions?: string[];
}

export function loadPersisted(): Persisted {
	return (api.getState() as Persisted | undefined) ?? {};
}

export function savePersisted(patch: Persisted): void {
	api.setState({ ...loadPersisted(), ...patch });
}
