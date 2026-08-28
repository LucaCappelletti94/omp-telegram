# omp-telegram

Telegram notifications and remote control for [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions, as a single extension. When a turn ends the agent writes a one line summary, picks an urgency light (green done, orange reply wanted, red blocked), and can attach tappable choices whose label starts the next turn. Questions asked through the `ask` tool appear simultaneously at the terminal and on Telegram with buttons, whichever side answers first wins, and the loser is dismissed. Several parallel sessions share one bot cleanly: every message carries an emoji badge naming its session, replies route back to the session that sent the message you replied to, and inside tmux every title names the window it came from.

## Setup

Create a bot with [@BotFather](https://t.me/BotFather) and treat the token like a password, because whoever holds it can steer your agent. Then, from a clone of this repo:

```
node setup.mjs
```

It validates the token, waits for you to message the bot once, resolves your chat id, and writes `~/.omp/agent/notify-telegram.json` with mode 600. Finish by listing the checkout in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/omp-telegram
```

New sessions pick it up, running ones need a restart. In that config file, `quietSeconds` (default 45) keeps turn end notices quiet while you are actively typing at the terminal, and `notifyOnTurnEnd: false` turns them off entirely. Since Telegram replaces omp's terminal bell, you may also want `completion.notify: "off"` and `ask.notify: "off"` in `config.yml`, which stops tmux from flagging windows with `!`.

If the bot has forum topic mode enabled, each session gets its own thread, renamed once omp titles the session and deleted on clean exit. Without it everything arrives flat and the emoji badge does the separating.

## Answering

Tap a button to answer a question, toggle a multi select, or pick a turn end choice. Type a reply to any message to steer the session that sent it, or send a bare message to steer whichever session notified you last. A reply whose target cannot be resolved is refused with an explanation rather than routed by guesswork, and a press on a question that was already answered, superseded, or answered at the terminal gets a closure notice. Text in questions renders a Markdown subset: inline code, fenced blocks with a language, bold, italic, strikethrough, spoilers, quotes, and links.

## Tests

```
npm test
```

runs 225 checks against a stubbed Telegram API and sends nothing. `npm run preview` prints exactly what a rendered question and a turn end notice look like. Node 23 or newer, or Bun.

## Security

Input is accepted only from the configured chat, and button presses additionally only from the configured sender. Everything else is dropped and logged. The extension assumes a private chat with a single person, and the bot token is a credential to the agent itself, not merely to notifications, so each person runs their own bot with their own token.
