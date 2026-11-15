# Change Log

All notable changes to the "bis-code" extension will be documented in this file.

The format follows [Keep a Changelog](http://keepachangelog.com/).

## [0.1.0]

### Added

- `@` mentions in the composer: fuzzy search across workspace files and folders, keyboard navigation, folder drill-down, highlighted mentions and chips. Mentioned files and folder listings are attached to the message, and secret files are never offered.
- Smoother UI: messages and tool cards animate in, streaming text flows in character by character with a cursor, a typing indicator, animated Thinking and tool-card expansion, and button and focus transitions. All motion respects the reduced-motion setting.

### Changed

- The chat now opens in the right-hand (secondary) sidebar instead of the activity bar.

## [0.0.1]

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
