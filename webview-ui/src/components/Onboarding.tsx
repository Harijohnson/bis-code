import { post } from '../vscodeApi';
import { Codicon, ExternalLink } from './common';

/** "Connect OpenRouter" card. The key itself is entered in a native VS Code input box, never here. */
export function ConnectCard({ message }: { message?: string }) {
	return (
		<div className="connect-card">
			<div className="connect-icon"><Codicon name="key" /></div>
			<h2>Connect OpenRouter</h2>
			{message && <p className="connect-error">{message}</p>}
			<p>
				bis-code runs on OpenRouter, so one API key gives you hundreds of models from Anthropic, OpenAI, Google and others.
			</p>
			<ol>
				<li>Create a key at <ExternalLink href="https://openrouter.ai/keys">openrouter.ai/keys</ExternalLink>.</li>
				<li>Click <b>Set API key</b> and paste it. It is stored in your OS keychain.</li>
			</ol>
			<button type="button" className="primary" onClick={() => post({ type: 'requestApiKey' })}>Set API key</button>
		</div>
	);
}

export function Onboarding() {
	return (
		<div className="onboarding">
			<ConnectCard />
		</div>
	);
}
