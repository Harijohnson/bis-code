import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
	const csp = [
		`default-src 'none'`,
		`script-src 'nonce-${nonce}'`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`img-src ${webview.cspSource} data: https:`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${asset('dist', 'codicons', 'codicon.css')}">
	<link rel="stylesheet" href="${asset('dist', 'webview.css')}">
	<title>bis-code</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
}
