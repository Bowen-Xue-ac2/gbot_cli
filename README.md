# gbot_cli 😊 🤝

An unofficial Windows terminal client for Grok Bot. Chat with bots and channels,
send follow-ups while a reply is in progress, and act on cards in the conversation.

[![Windows](https://img.shields.io/badge/platform-Windows-0078D4)](#quick-start)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853D)](#quick-start)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Features](#features) · [Keyboard controls](#keyboard-controls) · [Contributing](#contributing)

## Quick start

Use Windows Terminal or PowerShell with Git and Node.js 24 or later. Try the
offline demo from a fresh checkout.

```powershell
git clone https://github.com/Bowen-Xue-ac2/gbot_cli.git
cd gbot_cli
npm ci
npm run gbot -- --mock
```

For live chat, sign in to the Grok Bot desktop app first. Then check the connection
and open the bot and channel list.

```powershell
npm run gbot -- --check
npm run gbot
```

`--check` reports bot and channel counts without sending a chat message.
Use `npm run gbot -- --agent "Bot Name"` to open a chat directly.
Subcommands such as `bots list` and `approvals list` run through the pinned upstream CLI.

## Features

- **Keep chatting.** Send another prompt while a reply is in progress. Incoming replies appear as the transcript updates.
- **Recover reads after gateway sleep.** Refresh the session and retry once when HTTP 417 identifies a sleeping gateway.
- **Act on bot messages.** Answer choices, respond to supported approvals, and review or edit email drafts in the original card.
- **Read formatted replies.** View Markdown headings, lists, and tables, Mermaid diagrams, and LaTeX fractions and matrices in the terminal. Press **Ctrl+R** to see the source.

For example, `$$A=\begin{pmatrix}1&20\\300&4\end{pmatrix}$$` renders as terminal text.

```text
A = ⎛  1   20 ⎞
    ⎝ 300   4 ⎠
```

## Keyboard controls

| Key | Action |
| --- | --- |
| **Tab** | Focus a card in the conversation |
| **↑ / ↓**, **Enter** | Choose and confirm the focused card action |
| **y** | Confirm an email send when prompted |
| **Ctrl+R** | Toggle between formatted reply and Markdown source |

## Desktop account and data

The Windows adapter uses the account saved by the desktop app. Gateway credentials
stay in process memory. Runtime cache and temporary attachments are stored under
`%LOCALAPPDATA%\gbot-cli`. Gateway APIs can change, and some card types require
the desktop app. This project is independent of Grok Bot, Cursor, and xAI.

## Contributing

Run `npm test` for offline transport and terminal tests. Use `git commit -s -S`
to add a [DCO 1.1](DCO) sign-off and a GPG signature. See the [contribution guide](CONTRIBUTING.md),
[security policy](SECURITY.md), and [changelog](CHANGELOG.md).

Released under the [MIT license](LICENSE). Upstream CLI and TUI projects are
credited in the [third-party notices](THIRD_PARTY_NOTICES.md).

Maintained by [@Bowen-Xue-ac2](https://github.com/Bowen-Xue-ac2) 😄🤝
