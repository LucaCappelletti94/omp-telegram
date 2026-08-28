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

In the JSON config, `quietSeconds` (default 45) silences turn end notices while you are typing at the terminal, and `notifyOnTurnEnd: false` disables them. Setting `completion.notify` and `ask.notify` to `"off"` in `config.yml` stops omp's own bell from flagging tmux windows.

## Answering

Tap a button, reply to a session's message, or send a bare message for the last session that notified you. Unroutable messages are refused with an explanation, and presses on settled questions get a closure notice. Question text renders a Markdown subset: code, fences, bold, italic, strikethrough, spoilers, quotes, links.
