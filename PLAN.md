# bis-code — Implementation Plan

A VS Code extension that works like Claude Code: an agent that chats, reads and searches your project, edits files and runs commands. The difference is that all models come from **OpenRouter**, and you pick one from a searchable dropdown in the chat panel.

> Status: plan only. Nothing here is implemented yet. The current repo is the stock `yo code` TypeScript + esbuild + pnpm scaffold (`src/extension.ts` only has the Hello World command).

---

## 1. Goals and non-goals

### Goals (v1)
1. **Chat panel** in the activity bar (sidebar webview), with streaming responses, Markdown and code rendering.
2. **OpenRouter only.** One API key gives access to every OpenRouter model.
3. **API key handling**
   - **Local development:** read `OPENROUTER_API_KEY` from `.env` in the extension root.
   - **Installed extension:** ask the user for the key on first use and store it in VS Code `SecretStorage` (OS keychain). Never store it in settings or files.
4. **Model picker:** a searchable dropdown in the chat UI, filled from OpenRouter's `/models` endpoint. It shows name, context size, price and tool support. The selection is saved.
5. **Agent loop** with tools: read file, list directory, glob, grep, write file, edit file, run shell command, get diagnostics.
6. **Approvals:** reads run automatically. File edits show a diff and wait for approval. Commands always wait for approval unless allow-listed.
7. **Sessions:** start a new chat, see chat history and resume an old chat. Each turn shows token usage and cost.

### Non-goals (v1, revisit later)
- MCP servers, sub-agents, checkpoints/rewind, image input, inline completions, multiple providers, background or long-running terminals.

---

## 2. Architecture

```
┌──────────────────────────── VS Code Extension Host (Node) ────────────────────────────┐
│                                                                                        │
│  extension.ts ──► ApiKeyManager ──► SecretStorage / .env (dev only)                    │
│        │                                                                               │
│        ├──► ChatViewProvider (WebviewViewProvider)  ◄──── postMessage protocol ────┐   │
│        │          │                                                                │   │
│        │          ▼                                                                │   │
│        │     SessionManager ──► AgentLoop ──► OpenRouterClient ──► openrouter.ai   │   │
│        │                            │                                              │   │
│        │                            ▼                                              │   │
│        │                     ToolRegistry ──► PermissionGate ──► (approval UI) ────┤   │
│        │                            │                                              │   │
│        │                            ▼                                              │   │
│        │              workspace.fs / WorkspaceEdit / child_process / diagnostics   │   │
│        │                                                                           │   │
│        └──► ModelCatalog (fetch + cache /models)                                   │   │
└────────────────────────────────────────────────────────────────────────────────────│───┘
                                                                                     │
┌──────────────────────────── Webview (browser sandbox, React) ──────────────────────┴───┐
│  App ─ Header(ModelPicker, NewChat, History) ─ MessageList(ToolCallCard, Approval)     │
│      ─ Composer(textarea, Send/Stop, mode selector) ─ Onboarding(Connect OpenRouter)   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

| Decision | Choice | Why |
|---|---|---|
| UI surface | Custom `WebviewView` in its own activity-bar container | Full control over the UI. Does not depend on Copilot Chat or the VS Code chat participant API. |
| Where state lives | **Extension host owns all state.** The webview only displays it. | The webview can be destroyed when hidden. On `ready` it asks for the full state and rebuilds itself, so `retainContextWhenHidden` is not needed. |
| Where the API key lives | Extension host only. It **never** reaches the webview. | The webview runs in a browser sandbox, and the key should not pass through it. |
| HTTP client | Native `fetch` (Node in VS Code's Electron) plus a small SSE parser | No SDK lock-in. OpenRouter-specific fields (`usage`, `reasoning`, `provider`) are easy to send and read. Smaller bundle. |
| Tool-calling format | OpenAI-compatible `tools` / `tool_calls` (what OpenRouter uses) | Works across every model that supports tools on OpenRouter. |
| Webview framework | React + plain CSS that uses VS Code `--vscode-*` theme variables | Familiar and matches every theme. `@vscode/webview-ui-toolkit` is deprecated, so don't use it. |
| Build | Two esbuild contexts: extension (node/cjs) and webview (browser/iife) | Reuses the existing `esbuild.js`. No Vite or webpack needed. |
| File edits | `WorkspaceEdit` + `document.save()` | Edits respect open dirty editors, can be undone with Ctrl+Z and fire normal save hooks. |

---

## 3. API key and credential flow

### 3.1 How the key is found (first match wins)

```
1. Extension runs in Development mode (context.extensionMode === Development)
   AND <extensionRoot>/.env has OPENROUTER_API_KEY      → use it (not saved anywhere)
2. SecretStorage key "bisCode.openRouterApiKey"         → use it
3. Nothing found                                         → show the onboarding screen
```

`.env` is only read when `context.extensionMode === vscode.ExtensionMode.Development`, which is the case when you press F5. An installed `.vsix` never looks for it.

### 3.2 Local `.env` format

```dotenv
# .env  (extension root, NEVER commit, NEVER package)
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxx
# Optional: preselect a model during development (any id from /api/v1/models)
OPENROUTER_DEFAULT_MODEL=
# Optional: point at a mock server for tests
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

- Load it with `dotenv` (`dotenv.parse(fs.readFileSync(...))`). Do not mutate `process.env` globally.
- **Never** inline `.env` values at build time (for example with esbuild `define`). That would write the key into `dist/extension.js`.
- Commit a `.env.example` with empty values.

### 3.3 Production onboarding (installed extension)

1. The webview shows a **"Connect OpenRouter"** card: a short explanation, a link to `https://openrouter.ai/keys` and a **Set API key** button.
2. The button sends `{type: "requestApiKey"}` to the extension. The extension opens a native `vscode.window.showInputBox({ password: true, ignoreFocusOut: true, placeHolder: "sk-or-v1-..." })`. The key never goes through the webview.
3. **Validate** with `GET {baseUrl}/key` and `Authorization: Bearer <key>`.
   - 200: save with `context.secrets.store(...)` and send the new state to the webview. Optionally show the credit limit and usage from the response.
   - 401: show "Invalid key" and ask again.
   - Network error: offer to save anyway, then retry later.
4. Commands:
   - `bisCode.setApiKey`: set or replace the key.
   - `bisCode.clearApiKey`: delete the key and return to onboarding.
5. Listen to `context.secrets.onDidChange` so all open windows update together.
6. If any chat request returns **401**, clear the in-memory key, show onboarding inline in the chat and keep the user's unsent message.

### 3.4 Repo hygiene (do this first)
- Add `.env` and `.env.*` (except `.env.example`) to **`.gitignore`**. They are not there today.
- Add `.env` and `.env.*` to **`.vscodeignore`**. They are not there today either, so `vsce package` would put the key in the `.vsix`.

---

## 4. OpenRouter integration

### 4.1 Client (`src/openrouter/client.ts`)
- Base URL: `https://openrouter.ai/api/v1`. Can be overridden by `OPENROUTER_BASE_URL` in dev or the `bisCode.baseUrl` setting.
- Headers on every request:
  - `Authorization: Bearer <key>`
  - `Content-Type: application/json`
  - `HTTP-Referer: <extension repo/marketplace URL>` and `X-Title: bis-code` (OpenRouter app attribution)
- `chatStream(request, abortSignal)` returns an `AsyncIterable<StreamEvent>`.
- Request body:
  ```jsonc
  {
    "model": "<selected id>",
    "messages": [ /* system, user, assistant(with tool_calls), tool */ ],
    "tools": [ /* JSON-schema tool defs */ ],
    "tool_choice": "auto",
    "stream": true,
    "max_tokens": <setting>,
    "temperature": <setting, optional>,
    "usage": { "include": true }   // final chunk includes tokens + cost
  }
  ```

### 4.2 Streaming parser (`src/openrouter/stream.ts`)
- Read `response.body` as text, split on blank lines and handle `data: {...}` lines.
- **Skip SSE comment lines** that start with `:`. OpenRouter sends `: OPENROUTER PROCESSING` keep-alives.
- Stop at `data: [DONE]`.
- For each chunk, read `choices[0].delta`:
  - `content`: emit `text` events.
  - `reasoning` (if present): emit `reasoning` events. These appear in a collapsible "Thinking" block.
  - `tool_calls[]`: **accumulate by `index`**. `id` and `function.name` come first and `function.arguments` arrives in string pieces. Concatenate the pieces and only parse JSON when the stream ends.
  - `finish_reason`: `stop` | `tool_calls` | `length` | `error`.
- An error can also arrive **inside** the stream as a chunk with an `error` object. Treat it as a failed turn.
- Read `usage` (prompt, completion and total tokens, plus `cost`) from the last chunk.

### 4.3 Error mapping

| Status / case | Behaviour |
|---|---|
| 401 | Key invalid or revoked. Return to onboarding (see 3.3). |
| 402 | Out of credits. Show a message with a link to `https://openrouter.ai/credits`. |
| 429 / 502 / 503 | Retry up to 3 times with exponential backoff and jitter. After that, show an error with a **Retry** button. |
| 400 "tools not supported" | Tell the user the model can't use tools and suggest switching models or Chat-only mode. |
| `finish_reason: length` | Tell the user the output was cut off and offer **Continue**. |
| Abort (Stop button) | End quietly and mark the turn as "stopped". |

### 4.4 Model catalog (`src/openrouter/models.ts`)
- `GET {baseUrl}/models`. This endpoint is public and needs no auth.
- Keep these fields: `id`, `name`, `description`, `context_length`, `pricing.prompt`, `pricing.completion` (USD per token, sent as strings), `architecture.input_modalities`, `supported_parameters`, `top_provider.max_completion_tokens`.
- Add `supportsTools = supported_parameters.includes("tools")`.
- **Cache** in `context.globalState` with a 24 h TTL. Show the cached list right away and refresh it in the background. There is also a **Refresh** action.
- If the fetch fails and nothing is cached, show an error with **Retry**. The user can still type a model id by hand.

---

## 5. Model picker (chat dropdown)

### 5.1 Placement
In the chat header, a button shows the current model (for example `▾ Claude Sonnet · 200k`). Clicking it opens a popover with a search box. The same picker is also available as the command `bisCode.selectModel`, which uses a native `QuickPick` with the same data.

### 5.2 Behaviour
- **Search** matches `name` and `id` with simple ranking: exact prefix, then word prefix, then substring. That is fast enough for the roughly 300–500 models on OpenRouter without a fuzzy-search library.
- **Each row shows:** name, id in a muted font, context (`128k`), price (`$3 / $15 per 1M` in/out) and badges: `tools`, `vision`, `reasoning`, `free`.
- **Filters:**
  - "Tool-capable only" is **on by default**, because Agent mode needs tools.
  - Optional chips for Free, Vision and Provider (anthropic, openai, google, …), taken from the part of the id before `/`.
- **Sections:** Recent (last 5 used), then All (sorted by provider and name).
- **Keyboard:** ↑/↓ move, Enter selects, Esc closes, and typing goes to the search box.
- **Persistence:**
  - The selection is saved in `globalState` (`bisCode.selectedModel`).
  - The `bisCode.defaultModel` setting is used when nothing is saved.
  - In dev, `OPENROUTER_DEFAULT_MODEL` is used when neither is set.
- **Changing model mid-conversation** is allowed. The next request uses the new model, and a small divider appears in the transcript ("Switched to X").
- **Status bar item** (optional): shows the current model, and clicking it opens the picker.

---

## 6. Agent loop (`src/agent/agentLoop.ts`)

```
runTurn(session, userMessage):
  session.messages.push(user message (+ attached context))
  for iteration in 1..maxIterations (setting, default 25):
      stream = client.chatStream({ model, messages: buildContext(session), tools })
      forward text/reasoning deltas to webview as they arrive
      assistantMsg = collect(stream)                 // text + tool_calls + usage
      session.messages.push(assistantMsg)
      if no tool_calls: break                         // turn done
      results = await executeToolCalls(assistantMsg.tool_calls)
          // read-only tools run in parallel; mutating tools run sequentially,
          // each one goes through PermissionGate first
      session.messages.push(...results as role:"tool" messages with tool_call_id)
      if aborted: break
  if iteration hit max: tell user "Stopped after N steps" with a Continue button
  persist session, emit turnDone(usage, cost)
```

Details:
- **Malformed tool arguments** (bad JSON or schema mismatch): don't throw. Send the error back as the tool result (`"Invalid arguments: …"`) so the model can correct itself.
- **Unknown tool name:** same approach. Return an error result.
- **Cancellation:** a single `AbortController` per turn. It cancels the `fetch`, kills child processes and rejects any approvals still waiting.
- **Modes** (selector in the composer):
  - **Agent:** all tools, with approvals.
  - **Ask / Plan:** read-only tools only. Mutating tools are not sent to the model at all.
  - **Chat:** no tools. Works with models that lack tool support.

### 6.1 System prompt (`src/agent/systemPrompt.ts`)
Built fresh for each request from:
1. Base instructions: identity, coding agent behaviour, short answers, prefer `edit_file` over full rewrites, read before editing, don't invent file contents, ask when the request is ambiguous.
2. Environment: OS (`process.platform`), the user's shell (`vscode.env.shell`), workspace folder paths, today's date, and whether it's a git repo.
3. Editor context: active file path, selection (truncated) and open tabs (paths only).
4. **Project instructions file:** if `AGENTS.md` or `BIS.md` exists at the workspace root, include its contents. This works like `CLAUDE.md`.
5. Tool usage rules: paths are relative to the workspace root, run one command at a time, and avoid long-running or interactive commands (dev servers, watch modes, `git rebase -i`).

### 6.2 Context window management (`src/agent/context.ts`)
- Budget = `context_length` of the selected model − reserved output (`max_tokens`) − safety margin.
- Token estimate:
  - Before a request: `chars / 3.5`.
  - After a request: correct the estimate with the real `usage.prompt_tokens`.
- **Cap tool output** at about 30k chars. Keep the head and the tail, and put `…[truncated N chars]…` in between.
- **Compaction** happens at about 80% of the budget. Old turns are replaced with a summary written by the model, a dedicated non-streaming call with "summarize the work so far, files touched, open tasks". The last N turns are kept word for word. The UI shows a "Context compacted" divider.
- Optional fallback: OpenRouter `transforms: ["middle-out"]`.

---

## 7. Tools (`src/tools/*`)

Every tool has a JSON-schema definition sent to the model, an `execute(args, ctx)` function and a `permission` level.

| Tool | Args | Permission | Implementation notes |
|---|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | auto | `workspace.fs.readFile`. Returns lines with line numbers. Default 2000-line limit. Rejects binary files. Records the file's `mtime` in `session.readFiles`. |
| `list_dir` | `path` | auto | `workspace.fs.readDirectory`. Marks entries as dir or file. Skips `node_modules` and `.git` by default. |
| `glob` | `pattern`, `path?` | auto | `workspace.findFiles(pattern, excludes, maxResults=200)`. Respects `files.exclude` and `search.exclude`. |
| `grep` | `pattern` (regex), `path?`, `glob?`, `case_insensitive?` | auto | Use VS Code's bundled ripgrep, probing `${appRoot}/node_modules/@vscode/ripgrep/bin/rg[.exe]` and the `node_modules.asar.unpacked` variant. If neither exists, fall back to a JS scan over `findFiles` results. Return `path:line: text`, capped at 200 matches. |
| `get_diagnostics` | `path?` | auto | `vscode.languages.getDiagnostics()`. Returns errors and warnings with line numbers. |
| `write_file` | `path`, `content` | **ask** (auto in Auto-edit) | Creates or overwrites a file. If the file exists, it must have been read in this session and not changed on disk since. Applied with `WorkspaceEdit` and then saved. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | **ask** (auto in Auto-edit) | Exact string replacement. **Fails** if `old_string` is missing, or matches more than once while `replace_all` is false. The file must have been read first. Applied with `WorkspaceEdit`, so Ctrl+Z works. |
| `run_command` | `command`, `cwd?`, `timeout_ms?` | **ask** (unless matched by `bisCode.allowedCommands`) | `child_process.spawn` with the user's shell, `cwd` inside the workspace, 120 s default timeout and output capped at 30k chars. Output streams into the tool card. Kill on abort, using `taskkill /T /F /PID` on Windows. |

### 7.1 Safety rules (`src/tools/pathGuard.ts`, `src/agent/permissions.ts`)
- **Path guard:** resolve every path and reject it if it falls outside the workspace folders (`..` traversal, absolute paths elsewhere, symlinks that escape).
- **Secret-file guard:** by default, **deny reading** `.env*`, `*.pem`, `*.key`, `id_rsa*` and similar files, because their contents would be sent to a third-party model provider. The list can be changed with `bisCode.deniedReadGlobs`.
- **Always deny writes** to `.git/**`.
- **Workspace trust:** declare `capabilities.untrustedWorkspaces: { supported: "limited" }`. In an untrusted workspace, `write_file`, `edit_file` and `run_command` are turned off.
- **Command denylist** that blocks even when the user approves everything: `rm -rf /`, `format`, `del /s /q C:\`, `git push --force` to main, `curl … | sh`. Always show the exact command before it runs.

### 7.2 Approval UX
- **Edits:**
  - Register a `TextDocumentContentProvider` for the scheme `bis-code-proposed`.
  - Open `vscode.diff(original, proposed, "bis-code: file.ts (proposed)")`.
  - The tool card in the chat has **Accept**, **Reject** and **Accept all edits this session**.
  - If the user rejects, the model gets "User rejected this edit". The user can add a reason.
- **Commands:** the card shows the command and its cwd, with **Run**, **Reject** and **Always allow `<prefix>`**. The last option adds the prefix to the workspace setting `bisCode.allowedCommands`.
- An approval waiting for input pauses the loop. Stop cancels it.

---

## 8. Webview UI (`webview-ui/`)

### 8.1 Screens and components
- **Onboarding:** shown when there is no key. Has the Connect OpenRouter card.
- **Header:** ModelPicker, New chat (+), History (clock icon), and an overflow menu with Set API key, Clear API key and Settings.
- **MessageList:**
  - User bubble.
  - Assistant message: Markdown via `marked` + `DOMPurify`, code highlighted with `highlight.js`. Code blocks have **Copy** and **Insert at cursor** buttons.
  - Collapsible "Thinking" block for reasoning.
  - **ToolCallCard:** icon, tool name and a one-line summary (for example `Read src/extension.ts (120 lines)`). Expands to show arguments and output. Shows a spinner while running and a ✓ or ✗ when done.
  - **ApprovalCard:** Accept / Reject buttons (see 7.2).
  - Turn footer: model, tokens and `$cost`.
- **Composer:**
  - Auto-growing textarea. Enter sends and Shift+Enter adds a new line.
  - Send turns into **Stop** while a turn is running.
  - Mode selector (Agent / Plan / Chat).
  - Context chip for the active file or selection, which can be removed.
  - (v2) `@file` mentions and `/` commands.
- **History:** list of sessions (title and date). Click to resume. Each has a delete button.

### 8.2 Styling
- Use only VS Code theme variables, for example `--vscode-editor-background`, `--vscode-foreground`, `--vscode-button-background`, `--vscode-input-background` and `--vscode-focusBorder`. The UI then matches light, dark and high-contrast themes automatically.
- Codicons: copy `@vscode/codicons` CSS and font into `dist/` and reference them through `webview.asWebviewUri`.

### 8.3 Webview security
- Strict CSP: `default-src 'none'; script-src 'nonce-<random>'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:;`
- `localResourceRoots: [dist/, media/]`.
- Sanitize all model output with DOMPurify before inserting it. Never `eval` model output.
- Links in model output open through the extension (`vscode.env.openExternal`) after a check.

---

## 9. Message protocol (`src/shared/protocol.ts`, imported by both bundles)

Discriminated unions with a `type` field, so both sides are type-checked.

**Webview → Extension**
```ts
| { type: "ready" }
| { type: "requestApiKey" } | { type: "clearApiKey" }
| { type: "sendMessage"; text: string; includeActiveFile: boolean }
| { type: "stop" }
| { type: "selectModel"; modelId: string }
| { type: "refreshModels" }
| { type: "setMode"; mode: "agent" | "plan" | "chat" }
| { type: "approval"; callId: string; decision: "accept" | "reject" | "acceptAll" | "alwaysAllow"; reason?: string }
| { type: "newChat" } | { type: "loadSession"; id: string } | { type: "deleteSession"; id: string }
| { type: "openFile"; path: string; line?: number }
| { type: "insertCode"; code: string } | { type: "openExternal"; url: string }
```

**Extension → Webview**
```ts
| { type: "state"; hasApiKey: boolean; models: ModelInfo[]; selectedModel?: string; mode: Mode; session: SessionView; sessions: SessionSummary[] }
| { type: "models"; models: ModelInfo[]; stale: boolean }
| { type: "assistantStart"; messageId: string; model: string }
| { type: "textDelta"; messageId: string; text: string }
| { type: "reasoningDelta"; messageId: string; text: string }
| { type: "toolCall"; messageId: string; callId: string; name: string; args: unknown; status: "pending" | "awaitingApproval" | "running" | "done" | "error" | "rejected" }
| { type: "toolOutput"; callId: string; chunk: string }        // streaming command output
| { type: "toolResult"; callId: string; ok: boolean; summary: string; detail?: string }
| { type: "approvalRequest"; callId: string; kind: "edit" | "command"; preview: string }
| { type: "turnDone"; usage?: Usage; cost?: number; stopped?: boolean }
| { type: "error"; code: "auth" | "credits" | "rateLimit" | "network" | "model" | "unknown"; message: string; retryable: boolean }
```

Batch `textDelta` messages, for example every 30 ms, so the webview doesn't receive one message per token.

---

## 10. Sessions and persistence (`src/agent/session.ts`)
- A session holds `{ id, title, createdAt, updatedAt, modelHistory[], messages[] (OpenAI format), readFiles (path→mtime), totals: {tokens, cost} }`.
- Stored as JSON in `context.storageUri/sessions/<id>.json`, which is per workspace. If no folder is open, use `globalStorageUri`.
- **Title:** the first user message, truncated to about 60 chars. A short model-generated title can come later.
- Save at the end of each turn and on deactivate.
- Keep the newest 100 sessions per workspace. Older ones are deleted.

---

## 11. Settings, commands and manifest (`package.json` `contributes`)

**Settings**

| Key | Type | Default | Purpose |
|---|---|---|---|
| `bisCode.defaultModel` | string | `""` | Used when the user hasn't picked a model yet |
| `bisCode.maxIterations` | number | 25 | Maximum agent steps per turn |
| `bisCode.maxOutputTokens` | number | 8192 | `max_tokens` sent to OpenRouter |
| `bisCode.temperature` | number \| null | null | null means the model's default |
| `bisCode.autoApproveEdits` | boolean | false | Default for Auto-edit |
| `bisCode.allowedCommands` | string[] | `[]` | Command prefixes that run without asking |
| `bisCode.deniedReadGlobs` | string[] | (secret files) | See 7.1 |
| `bisCode.commandTimeoutMs` | number | 120000 | Timeout for `run_command` |
| `bisCode.baseUrl` | string | OpenRouter URL | For proxies or tests |
| `bisCode.showOnlyToolModels` | boolean | true | Default for the picker filter |

**Commands:** `bisCode.focus` (open chat), `bisCode.newChat`, `bisCode.selectModel`, `bisCode.setApiKey`, `bisCode.clearApiKey`, `bisCode.refreshModels`, `bisCode.addSelectionToChat` (editor context menu), `bisCode.stop`.

**Keybinding:** `Ctrl+Alt+B` / `Cmd+Alt+B` for `bisCode.focus`. Check this doesn't clash with existing bindings.

**Views:** `viewsContainers.activitybar` with id `bisCode` and icon `media/icon.svg`, plus `views.bisCode: [{ type: "webview", id: "bisCode.chat", name: "Chat" }]`.

**Activation:** VS Code ≥1.74 activates extensions automatically from contributed views and commands, so `activationEvents` can stay `[]`.

**Manifest fixes:**
- Add `publisher`, `repository`, `icon`, `license` and a real `description`.
- Change `categories` to `["AI", "Chat", "Programming Languages"]`.
- Add `capabilities.untrustedWorkspaces`.
- Remove the Hello World command.

---

## 12. Proposed file layout

```
bis-code/
├─ .env.example                  # OPENROUTER_API_KEY= (empty), committed
├─ .env                          # local only, git-ignored + vscode-ignored
├─ esbuild.js                    # + second context for webview-ui
├─ media/icon.svg
├─ src/
│  ├─ extension.ts               # activate(): wire everything, register commands/view
│  ├─ config/
│  │  ├─ devEnv.ts               # .env loader, Development mode only
│  │  ├─ apiKeyManager.ts        # resolve/store/validate/clear key, onDidChange
│  │  └─ settings.ts             # typed getters for bisCode.* settings
│  ├─ openrouter/
│  │  ├─ client.ts               # fetch, headers, retries, error mapping
│  │  ├─ stream.ts               # SSE parser + tool_call accumulator
│  │  ├─ models.ts               # ModelCatalog: fetch, cache, normalize
│  │  └─ types.ts
│  ├─ agent/
│  │  ├─ agentLoop.ts
│  │  ├─ systemPrompt.ts
│  │  ├─ context.ts              # budgeting, truncation, compaction
│  │  ├─ session.ts              # SessionManager + persistence
│  │  └─ permissions.ts          # PermissionGate, modes, allow/deny lists
│  ├─ tools/
│  │  ├─ registry.ts             # defs (JSON schema) + dispatch
│  │  ├─ pathGuard.ts
│  │  ├─ readFile.ts  listDir.ts  glob.ts  grep.ts  diagnostics.ts
│  │  ├─ writeFile.ts editFile.ts runCommand.ts
│  │  └─ diffPreview.ts          # bis-code-proposed: content provider + vscode.diff
│  ├─ webview/
│  │  ├─ ChatViewProvider.ts     # resolveWebviewView, message routing
│  │  └─ html.ts                 # HTML shell, CSP, nonce, asset URIs
│  ├─ shared/
│  │  └─ protocol.ts             # message types used by both sides
│  └─ test/
│     ├─ unit/                   # stream, accumulator, editFile, pathGuard, models
│     └─ integration/            # @vscode/test-electron against mock server
└─ webview-ui/
   ├─ tsconfig.json              # lib: DOM, jsx: react-jsx
   └─ src/
      ├─ main.tsx  App.tsx  vscodeApi.ts  store.ts
      ├─ components/ Onboarding.tsx Header.tsx ModelPicker.tsx MessageList.tsx
      │              Message.tsx ToolCallCard.tsx ApprovalCard.tsx Composer.tsx History.tsx
      └─ styles.css
```

### Dependencies to add
- **Extension runtime:** `dotenv`
- **Webview runtime:** `react`, `react-dom`, `marked`, `dompurify`, `highlight.js`, `@vscode/codicons`
- **Dev:** `@types/react`, `@types/react-dom`, `@types/dompurify` (if needed), `@vscode/vsce`

The project already pins `diff` in `overrides`. Add `diff` as a real dependency if unified diffs are wanted in tool results.

### Build changes
- `esbuild.js`: add a second context with entry `webview-ui/src/main.tsx`, `platform: "browser"`, `format: "iife"` and `outfile: "dist/webview.js"`. It also emits `dist/webview.css`. Run both contexts in watch mode.
- Root `tsconfig.json`: exclude `webview-ui`. Add `webview-ui/tsconfig.json` and update `check-types` to run both.
- `eslint src webview-ui/src`.

---

## 13. Phased roadmap

Each phase ends in a state you can run and demo with F5.

### Phase 0 — Groundwork (½ day)
- Fix `.gitignore` and `.vscodeignore` (add `.env`) and add `.env.example`.
- Clean up `package.json` (publisher, categories, view container, remove Hello World).
- Two-bundle esbuild, webview tsconfig, empty React "Hello" webview in the sidebar.
- **Done when:** F5 opens the dev host, the bis-code icon appears in the activity bar, and the panel renders with theme colors.

### Phase 1 — API key + OpenRouter client (1 day)
- `devEnv.ts`, `apiKeyManager.ts` (resolution order, SecretStorage, `/key` validation), and the `setApiKey`/`clearApiKey` commands.
- `client.ts` and `stream.ts` with unit tests (text deltas, comment lines, `[DONE]`, split tool-call arguments, errors inside the stream).
- **Done when:** with `.env` present, F5 needs no prompt. Without it, the onboarding input box appears, rejects a bad key and stores a good one. Reloading the window keeps the key.

### Phase 2 — Basic streaming chat (1–2 days)
- `ChatViewProvider`, protocol, store, MessageList with Markdown and code, Composer with Send and Stop.
- Plain chat with no tools, using a fixed model.
- Error cards for 401, 402, 429 and network errors.
- **Done when:** you can hold a multi-turn conversation, responses stream smoothly, Stop cancels immediately, and hiding and reopening the panel restores the transcript.

### Phase 3 — Model picker (1 day)
- `ModelCatalog` (fetch, normalize, 24 h cache) and the `ModelPicker` popover (search, badges, prices, filters, Recent, keyboard navigation).
- `bisCode.selectModel` QuickPick and persistence.
- **Done when:** typing "sonn" or "gpt" narrows the list right away, the selection survives a reload, and the turn footer shows the model actually used.

### Phase 4 — Agent loop + read-only tools (2 days)
- `agentLoop.ts`, `registry.ts`, `pathGuard.ts`, and the tools `read_file`, `list_dir`, `glob`, `grep` and `get_diagnostics`.
- `systemPrompt.ts` with environment details and `AGENTS.md`.
- ToolCallCard UI and Plan mode.
- **Done when:** "Explain how activation works in this project" makes the model list, grep and read files on its own and answer correctly, and every tool call is visible in the transcript.

### Phase 5 — Editing + approvals (2 days)
- `edit_file`, `write_file`, read-before-edit tracking and the mtime check.
- `diffPreview.ts`, ApprovalCard, PermissionGate, and Auto-edit mode.
- **Done when:** asking for a change opens a diff, Accept applies it (Ctrl+Z undoes it) and Reject sends that back to the model, which adapts. Edits outside the workspace or to `.env` are refused.

### Phase 6 — Shell commands (1–2 days)
- `run_command`: spawn with the user's shell, stream output, timeout, kill process tree, allowlist and denylist, "Always allow prefix".
- **Done when:** "run the tests and fix what fails" works end to end on Windows (PowerShell) and on macOS or Linux.

### Phase 7 — Sessions, context, cost (1–2 days)
- SessionManager persistence, History view, New chat.
- Token budgeting, tool-output caps, compaction.
- Per-turn and per-session cost display.
- **Done when:** a long refactor session compacts without errors, old chats can be resumed, and the costs shown match the OpenRouter activity page.

### Phase 8 — Hardening + release (1–2 days)
- Integration tests against a **mock OpenRouter server** (a local `http` server that replays recorded SSE fixtures, selected with `OPENROUTER_BASE_URL`).
- Workspace-trust handling, accessibility pass (keyboard navigation, aria labels, high-contrast theme), README with GIFs and CHANGELOG.
- `vsce package --no-dependencies` (the bundle is self-contained, which avoids pnpm symlink problems). Inspect the `.vsix` contents to confirm there is no `.env` and no `src/`.
- **Done when:** a clean `.vsix` installs into a fresh VS Code profile, onboarding works, and the full agent flow passes the manual checklist below.

### Later (v2+)
- `@file` / `@folder` mentions and `/` slash commands (`/clear`, `/compact`, `/model`, `/init` to generate `AGENTS.md`).
- Checkpoints: snapshot files before each turn so a turn can be undone.
- Run commands in the VS Code terminal using shell integration, for long-running processes.
- MCP client support (stdio and HTTP servers) for extra tools.
- Image and screenshot input for vision models.
- Prompt caching (`cache_control`) for Anthropic and Gemini models on OpenRouter, which cuts cost a lot on long sessions.
- Sub-agents and parallel tasks, and a reasoning-effort control for reasoning models.
- OpenRouter provider routing preferences (`provider.order`, `allow_fallbacks`, data-collection policy).

---

## 14. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | SSE parser, tool-call accumulator, error mapping | Mocha with recorded SSE fixtures (real OpenRouter streams saved to `src/test/fixtures/*.sse`) |
| Unit | `edit_file` matching rules, `pathGuard`, secret-file guard, command denylist | Pure functions with table-driven tests |
| Unit | Model search ranking and filters | Fixture of a real `/models` response |
| Integration | Agent loop end to end | `@vscode/test-electron` + mock server. Scripted model replies call tools against a temp workspace, then the test checks the files on disk. |
| Manual | Checklist (below) | Before each release |

**Manual release checklist**
1. Fresh profile, no key: onboarding appears. A bad key is rejected and a good key is stored.
2. Picker: search works, the tool filter works and the selection persists.
3. Agent: explains the codebase using only read tools.
4. Edit: the diff appears and Accept, Reject and Undo all work.
5. Command: the approval appears, output streams, and Stop kills the process.
6. 401 after revoking the key: onboarding appears inline and the draft is kept.
7. Light, dark and high-contrast themes all render correctly.
8. Untrusted workspace: write and command tools are disabled.
9. `.vsix` contents contain no `.env`.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Models differ a lot in how well they call tools | Default the picker to tool-capable models. Send bad arguments back to the model so it can retry. Cap iterations. Recommend a few known-good models in the README. |
| Secrets leak to the model provider (agent reads `.env`) | Deny secret-file reads by default (7.1). Mention this in the README. |
| Destructive commands | Approval by default, a denylist that can't be overridden, the exact command shown, workspace-only cwd. |
| Cost surprises | Show cost per turn and per session. Optional future setting to warn when a session passes $X. |
| ripgrep path changes between VS Code versions | Probe several paths and fall back to a JS search. |
| Large repos / huge files | Result caps on glob and grep, line limits on read, binary detection, and excluding `node_modules`. |
| Webview memory/perf with long transcripts | Batch deltas. Virtualize the message list if it becomes a problem. Compaction keeps history bounded. |
| Windows shell differences | Use the user's `vscode.env.shell`, tell the model which shell it is in the system prompt, and kill processes with `taskkill /T`. |

---

## 16. Open questions to decide before Phase 2
1. **Name and branding:** is "bis-code" the final marketplace name? This affects the setting and command prefixes (`bisCode.*`), which are hard to change later.
2. **Project instructions file name:** `AGENTS.md` (an emerging cross-tool convention), `BIS.md`, or support both?
3. **Default model** for first-time users: leave it empty and make them choose, or preselect a recommended tool-capable model?
4. **Publishing target:** VS Code Marketplace only, or Open VSX too (for Cursor, Windsurf and VSCodium users)?
