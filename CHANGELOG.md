# Change Log

All notable changes to the "bis-code" extension will be documented in this file.

The format follows [Keep a Changelog](http://keepachangelog.com/).

## [Unreleased]

### Added

- Chat panel in the activity bar with streaming Markdown, code blocks (Copy / Insert at cursor) and reasoning blocks.
- OpenRouter integration: API key onboarding with validation, stored in SecretStorage; `.env` support in Development mode only.
- Searchable model picker (webview popover and `bisCode.selectModel` QuickPick) with prices, context size, badges, filters and recent models; status bar item.
- Agent loop with `read_file`, `list_dir`, `glob`, `grep`, `get_diagnostics`, `edit_file`, `write_file` and `run_command`.
- Approvals: diff preview with Accept / Reject / Accept all edits, and command approval with Always allow.
- Agent, Plan and Chat modes; Auto-edit toggle.
- Safety: workspace path guard, secret-file guard, `.git` write denial, command denylist, read-before-write checks and workspace-trust limits.
- Sessions with history, resume and delete; per-turn and per-session token and cost display; automatic context compaction.
- Unit tests and VS Code integration tests against a mock OpenRouter server.
- Sub-agents: `explore` (read-only, runs in parallel) and `delegate` (edits and commands with approvals); the main agent can send follow-ups with `agent_id`.
- Project map: a `.gitignore`-aware map of the workspace's files, built when a project is opened, kept current and added to the system prompt. `bis-code: Show Project Map` command.
- `grep` options `context_lines` and `files_only`.
- In untrusted workspaces, the first edit or command asks you to trust the workspace (opens the Workspace Trust editor) instead of failing; the composer's **Restricted** label opens it too.

### Changed

- System prompt: principal-engineer working standard, targeted search before reading, stricter no-guessing rules, and asking only the questions that are necessary.
- UI accent color `#4fc4a3` (with a darker shade for text in light themes).

### Fixed

- `grep` and the project map find ripgrep in newer VS Code builds (`@vscode/ripgrep-universal`) instead of falling back to a slow JavaScript scan.
- `grep` with `path` pointing at a single file no longer fails in the JavaScript fallback.
