# omp-telegram

[![CI](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/LucaCappelletti94/omp-telegram/graph/badge.svg)](https://codecov.io/gh/LucaCappelletti94/omp-telegram)
[![Quality gate](https://sonarcloud.io/api/project_badges/measure?project=LucaCappelletti94_omp-telegram&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=LucaCappelletti94_omp-telegram)
[![License](https://img.shields.io/github/license/LucaCappelletti94/omp-telegram)](https://github.com/LucaCappelletti94/omp-telegram/blob/main/LICENSE)

Telegram notifications and remote control for [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions. Turn ends arrive as a short agent-written summary of a sentence or two with an urgency light and optional tappable choices whose label starts the next turn. `ask` questions appear at the terminal and on Telegram at once, and the first answer wins.

Parallel sessions share one bot. Each session message names its task, current model, and exact tmux `session:window.pane` when attached, while its badge keeps replies routed to that session. A badge emoji is chosen by the session's own agent to depict its task, and is unique among live sessions. If the target Telegram group has forum topics enabled, each session gets its own thread instead.

## Setup

Create a bot with [@BotFather](https://t.me/BotFather), then:

```
git clone https://github.com/LucaCappelletti94/omp-telegram
cd omp-telegram
node setup.mjs
```

It validates the token, then waits for you to message the bot. That message has to be a private one, sent directly to the bot, since the pairing binds a single direct chat and a group message cannot stand in for it. It then writes `~/.omp/agent/notify-telegram.json`. Then list the checkout in `~/.omp/agent/config.yml` and restart omp:

```yaml
extensions:
  - ~/path/to/omp-telegram
```

In the JSON config, `quietSeconds` (default 45) silences turn end notices while you are typing at the terminal, `notifyOnTurnEnd: false` disables them, and `streamDrafts: false` turns off live draft streaming. `pinnedDashboard: true` adds a pinned message that always shows every live session and rewrites itself in place, no more than once every `dashboardSeconds` (default 30) and only when the text actually changed. Edits apply within about fifteen seconds to sessions already running, so no restart is needed. Setting `completion.notify` and `ask.notify` to `"off"` in `config.yml` stops omp's own bell from flagging tmux windows.

## Answering

Tap a button, reply to a session's message, or send a bare message for the last session that notified you. Replying to a question message answers it directly in your own words, photos reach the agent as images, and voice notes, audio files, and documents are saved to disk and handed to the agent as file paths. While a turn runs the chat shows a typing status, delivered messages get a thumbs-up reaction, red statuses stay pinned until the next turn, and `/hidequestions` clears open question buttons. Unroutable messages are refused with an explanation, and presses on settled questions get a closure notice. Question text renders a Markdown subset: code, fences, bold, italic, strikethrough, spoilers, quotes, links.

While a turn runs, the answer streams into an ephemeral draft bubble with the same task, model, and tmux context, tool activity, and a native Stop button that aborts the turn. Turn-end summaries report tokens and cost separately for each model, rich content stays native, artifacts arrive as media or documents, and a finished green summary can close the session and its tmux tab. `/status` reports session state, `/fleet` lists omp tmux windows, context compaction announces itself, retries and model fallbacks show as a provider note on the board and in `/status` rather than a message per session, and all commands sit in the bot menu.
