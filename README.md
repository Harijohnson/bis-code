# bis-code

An AI coding agent for VS Code that works like Claude Code: it chats with you, reads and searches your project, edits files and runs commands. Every model comes from **[OpenRouter](https://openrouter.ai)**, and you pick one from a searchable dropdown in the chat.

## Features

- **Chat panel** in the right-hand (secondary) sidebar with smoothly streaming Markdown, syntax-highlighted code blocks (Copy / Insert at cursor) and a collapsible "Thinking" block for reasoning models.
- **Any OpenRouter model.** A searchable picker shows context size, price and `tools` / `vision` / `reasoning` / `free` badges, with filters and a Recent section. You can switch model mid-conversation.
- **@-mentions.** Type `@` to fuzzy-search workspace files and folders. A mentioned file's contents (or a folder's listing) are attached to your message.
- **Agent tools:** `read_file`, `list_dir`, `glob`, `grep` (VS Code's bundled ripgrep), `get_diagnostics`, `edit_file`, `write_file` and `run_command`.
- **You stay in control.** Edits open a diff and wait for **Accept / Reject**, and can be undone with Ctrl+Z. Commands show the exact command line and wait for **Run / Reject / Always allow**.
- **Three modes:** **Agent** (all tools), **Plan** (read-only) and **Chat** (no tools; works with any model).
- **Sessions:** start a new chat, browse history and resume. Each turn shows tokens and cost, and long chats are compacted automatically.

## Getting started

1. Install the extension and open the chat in the right-hand sidebar: click the **bis-code** icon there, or press `Ctrl+Shift+Alt+B` / `Cmd+Shift+Alt+B`. You can drag it to another sidebar or the panel if you prefer.
2. Click **Set API key**, create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it. The key is checked against OpenRouter and stored in your OS keychain (VS Code `SecretStorage`). It is never written to settings or files and never reaches the webview.
3. Pick a model from the dropdown at the top of the chat, then ask away.

### Choosing a model

Agent and Plan modes need a model that supports tool calling. That is why the picker shows "Tool-capable" models by default. Strong choices for coding include `anthropic/claude-sonnet-4`, `openai/gpt-4.1` and `google/gemini-2.5-pro`. Any model with the **tools** badge works. Models without tool support can still be used in **Chat** mode.

## Modes

| Mode | Tools sent to the model | Use it for |
|---|---|---|
| Agent | All, with approvals | Making changes, running tests, fixing failures |
| Plan | Read-only (`read_file`, `list_dir`, `glob`, `grep`, `get_diagnostics`) | Understanding code and planning changes safely |
| Chat | None | Plain conversation; works with every model |

## Mentioning files and folders

Type `@` in the message box (or click the **@** button) to open the file picker:

- Type part of a name or path. Matching is fuzzy, so `@ctrl` finds `controller.ts` and `@cvp` finds `ChatViewProvider.ts`. Open editors are listed first.
- **↑ / ↓** move, **Enter** adds the selected file or folder, **Tab** on a folder shows the files inside it, and **Esc** closes the picker.
- Each mention appears as a chip above the input. Remove the chip, or delete the `@path` text, to drop it.

When you send, each mentioned file's contents (up to about 60 KB per file) are attached to your message. A mentioned folder attaches a listing of its entries. Files attached in full count as read, so the agent can edit them straight away. Secret files blocked by `bisCode.deniedReadGlobs` never appear in the picker and are never attached.

**Auto-edit** (the composer checkbox, or `bisCode.autoApproveEdits`) applies edits without asking. Commands still ask unless they match `bisCode.allowedCommands`.

## Safety

- **Workspace only.** Paths outside your workspace folders are rejected, including `..` traversal and symlinks that point outside.
- **Secret files are never read.** `.env*`, `*.pem`, `*.key`, SSH keys and similar files are blocked by default, because their contents would be sent to a third-party model provider. You can change the list with `bisCode.deniedReadGlobs`.
- **No writes inside `.git`.**
- **Read before write.** The agent must read a file before changing it, and the change is refused if the file changed on disk in the meantime.
- **Command denylist.** Commands such as `rm -rf /`, `format C:`, force-pushing to `main` or piping `curl` into a shell are blocked even if you allow everything.
- **Allow-listed prefixes only match simple commands.** Commands containing `&&`, `|`, `;`, redirection or `$(…)` always ask.
- **Untrusted workspaces:** editing and running commands are turned off.

## Project instructions

If an `AGENTS.md` or `BIS.md` file exists at the workspace root, its contents are added to the system prompt, much like `CLAUDE.md`. Use it for build commands, conventions and things the agent should know.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `bisCode.defaultModel` | `""` | Model used until you pick one |
| `bisCode.maxIterations` | `25` | Maximum agent steps per turn |
| `bisCode.maxOutputTokens` | `8192` | `max_tokens` sent to OpenRouter (capped by the model) |
| `bisCode.temperature` | `null` | `null` uses the model's default |
| `bisCode.autoApproveEdits` | `false` | Default for Auto-edit |
| `bisCode.allowedCommands` | `[]` | Command prefixes that run without asking |
| `bisCode.deniedReadGlobs` | secret files | Files the agent may never read or write (`!pattern` = exception) |
| `bisCode.commandTimeoutMs` | `120000` | Default `run_command` timeout |
| `bisCode.baseUrl` | `https://openrouter.ai/api/v1` | For proxies or tests |
| `bisCode.showOnlyToolModels` | `true` | Default for the picker's "Tool-capable" filter |

## Commands

`bis-code: Open Chat`, `New Chat`, `Select Model` (also available from the status bar), `Set OpenRouter API Key`, `Clear OpenRouter API Key`, `Refresh Model List`, `Add Selection to Chat` (editor context menu) and `Stop Current Turn`.

## Costs

Each turn shows its token usage and the cost OpenRouter reports, and the header shows the running total for the chat. You can check these against your [OpenRouter activity page](https://openrouter.ai/activity).

---

## Development

```bash
pnpm install
cp .env.example .env      # then set OPENROUTER_API_KEY (optional)
```

Press **F5** to launch an Extension Development Host. When the extension runs in Development mode, it reads `OPENROUTER_API_KEY`, `OPENROUTER_DEFAULT_MODEL` and `OPENROUTER_BASE_URL` from `.env` in the extension root, so you don't need to enter a key. An installed `.vsix` never reads `.env`. `.env` is ignored by git and excluded from packaging.

| Script | What it does |
|---|---|
| `pnpm run watch` | esbuild (extension + webview) and both type-checkers in watch mode |
| `pnpm run compile` | Type-check, lint and build once |
| `pnpm run test:unit` | Fast unit tests in plain Node (SSE parser, tool-call accumulator, edit matching, path guard, secret globs, command policy, model search, compaction, client retries) |
| `pnpm test` | Unit and integration tests inside VS Code, against a local mock OpenRouter server |
| `pnpm run package` | Production build |
| `pnpm run vsix` | Build a `.vsix` (`vsce package --no-dependencies`; the bundle is self-contained) |

### Layout

```
src/
  extension.ts            activate(): wiring, commands, view
  config/                 .env loader (dev only), API key manager, typed settings
  openrouter/             HTTP client, SSE parser, model catalog
  agent/                  agent loop, controller, system prompt, context/compaction, sessions, permissions
  tools/                  tool implementations, path guard, diff preview
  webview/                WebviewViewProvider + HTML/CSP
  shared/                 protocol + transcript reducer used by both bundles
webview-ui/src/           React UI (bundled to dist/webview.js)
```
