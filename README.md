# omp-telegram

[![CI](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml)

Telegram notifications and remote control for [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions. Turn ends arrive as a one line agent-written summary with an urgency light and optional tappable choices whose label starts the next turn. `ask` questions appear at the terminal and on Telegram at once, and the first answer wins.

Parallel sessions share one bot: each message carries a session badge, replies route to the session that sent the replied-to message, and titles name the tmux window. With forum topic mode enabled on the bot, each session gets its own thread instead.

## Setup

Create a bot with [@BotFather](https://t.me/BotFather), then:

```
git clone https://github.com/LucaCappelletti94/omp-telegram
cd omp-telegram
node setup.mjs
```

It validates the token, resolves your chat id from one message, and writes `~/.omp/agent/notify-telegram.json`. Then list the checkout in `~/.omp/agent/config.yml` and restart omp:

```yaml
extensions:
  - ~/path/to/omp-telegram
```

In the JSON config, `quietSeconds` (default 45) silences turn end notices while you are typing at the terminal, `notifyOnTurnEnd: false` disables them, and `streamDrafts: false` turns off live draft streaming. Setting `completion.notify` and `ask.notify` to `"off"` in `config.yml` stops omp's own bell from flagging tmux windows.

## Answering

Tap a button, reply to a session's message, or send a bare message for the last session that notified you. Replying to a question message answers it directly in your own words, photos reach the agent as images, and voice notes, audio files, and documents are saved to disk and handed to the agent as file paths. While a turn runs the chat shows a typing status, delivered messages get a thumbs-up reaction, red statuses stay pinned until the next turn, and `/hidequestions` clears open question buttons. Unroutable messages are refused with an explanation, and presses on settled questions get a closure notice. Question text renders a Markdown subset: code, fences, bold, italic, strikethrough, spoilers, quotes, links.

While a turn runs, the answer streams into an ephemeral draft bubble with tool activity and a native Stop button that aborts the turn. Turn-end summaries carry a token and cost footer, summaries with tables or code fences render as native rich messages, and the agent can push screenshots and other artifacts to the chat as photos, albums, or documents. `/status` reports what each session is doing without disturbing it, retries, model fallbacks, and context compaction announce themselves, and both commands sit in the bot's menu button.
