# gbot_cli

An unofficial Windows terminal client for Grok Bot. Read bot and channel chats,
send follow-up messages while the bot is answering, and act on questions,
supported approvals and email drafts in the message that contains them.

## Quick start

- Windows, Node.js 24 or later, and an interactive terminal for chat.
- For live use, sign in to the Grok Bot desktop app first.

```powershell
npm ci
npm run gbot -- tui --help
npm run gbot -- --mock
npm run gbot -- --check
npm run gbot
```

`--mock` runs offline. `--check` authenticates and reports bot and channel counts
without sending a chat message. In live chat, `--agent NAME` opens a selected
chat. Other subcommands, such as `bots list` and `approvals list`, use the pinned
upstream CLI.

The reader styles Markdown, draws Mermaid diagrams, and typesets LaTeX in
terminal characters, including fractions and matrices. Press **Ctrl+R** to
switch to or from source. Use **Tab** to focus a card, then the arrow keys and
**Enter** to choose an action. Email sends require a separate **y** confirmation.

## Runtime and development

The login stays managed by the desktop app. The Windows adapter uses the active
saved account and stores runtime cache and temporary attachments under
`%LOCALAPPDATA%\gbot-cli`. Gateway credentials are held in memory.

Run `npm test` for mocked transport and terminal tests. The upstream CLI and
TUI are installed from npm via the lockfile. The launcher applies compatibility
patches in memory. See [Security](SECURITY.md), [Contributing](CONTRIBUTING.md),
and [third-party notices](THIRD_PARTY_NOTICES.md).

Grok Bot gateway APIs can change. Unsupported card types can require the desktop
app. This project is independent of Grok Bot, Cursor and xAI.
