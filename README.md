# omp-telegram

[![CI](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/LucaCappelletti94/omp-telegram/graph/badge.svg)](https://codecov.io/gh/LucaCappelletti94/omp-telegram)
[![Quality gate](https://sonarcloud.io/api/project_badges/measure?project=LucaCappelletti94_omp-telegram&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=LucaCappelletti94_omp-telegram)
[![License](https://img.shields.io/github/license/LucaCappelletti94/omp-telegram)](https://github.com/LucaCappelletti94/omp-telegram/blob/main/LICENSE)

Telegram notifications and remote control for [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions. Turn ends arrive as a short agent-written summary with an urgency light and optional tappable choices whose label starts the next turn; every choice carries a line saying what it does. `ask` questions appear at the terminal and on Telegram at once, and the first answer wins.

Parallel sessions share one bot. Every message opens with the session's badge and then its task, model, and tmux `session:window.pane` when attached, so a phone notification identifies itself and keeps replies routed. The badge emoji is chosen by the session's own agent and is unique among live sessions.

## Setup

Create a bot with [@BotFather](https://t.me/BotFather), then:

```
git clone https://github.com/LucaCappelletti94/omp-telegram
cd omp-telegram
node setup.mjs
```

It validates the token, then waits for a direct private message to the bot; the pairing binds one direct chat, so a group message does not work. It writes `~/.omp/agent/notify-telegram.json`. List the checkout in `~/.omp/agent/config.yml` and restart omp:

```yaml
extensions:
  - ~/path/to/omp-telegram
```

JSON config (`~/.omp/agent/notify-telegram.json`):

- `quietSeconds` (default 45): turn-end notices arrive without sound while you are typing at the terminal.
- `notifyOnTurnEnd: false`: disables turn-end notices.
- `streamDrafts: false`: turns off live draft streaming.
- `pinnedDashboard: true`: a pinned message showing every live session, rewritten in place at most every `dashboardSeconds` (default 30) when the text changed.
- `userName`: what `ask` options call you, as in "Luca will review the diff". Learned from your Telegram first name on your first message or button press, and a name written here by hand is kept.

Setting `completion.notify` and `ask.notify` to `"off"` in `config.yml` stops omp's bell from flagging tmux windows. Edits apply to running sessions within about fifteen seconds, so no restart is needed.

## Answering

- Tap a button, reply to a session's message, or send a bare message to the last session that notified you; while a question is open, any text to that session answers it.
- Photos reach the agent as images; voice notes, audio files, and documents are saved to disk and handed over as file paths.
- Files are named `<UTC stamp>__<kind>__<session>__<original name>`, incoming ones carrying the Telegram update id; a photo repeats the name in its caption because Telegram drops photo filenames.
- The chat shows a typing status while the session works your answer and an upload status while a file goes up; delivered messages get a thumbs-up reaction; red statuses stay pinned until the next turn; `/hidequestions` clears open question buttons.
- Unroutable messages are refused with an explanation; presses on settled questions get a closure notice.
- Question text renders a Markdown subset: code, fences, bold, italic, strikethrough, spoilers, quotes, links.
- Question options and turn-end buttons name who acts, "Agent will …" or your name, and one saying I, me, you, your, we or us is refused, because a tapped option reads as your own reply and a pronoun there could mean either side.
- Text meant to be pasted elsewhere arrives as its own message ending in one fenced block holding it verbatim; payloads too large for one message are refused rather than cut and go as a file.
- While a turn runs, the answer streams into an ephemeral draft bubble with the same head and the tool activity.
- `/stop` aborts the running turn: sent bare it reaches the one session mid-turn and offers a button per session when several are, sent as a reply it stops the session that message belongs to.
- Turn-end summaries report tokens and cost per model; rich content stays native; artifacts arrive as media or documents; a finished green summary can close the session and its tmux tab.
- A green summary plays the Telegram send effect its agent chose for how the turn went, one of 🎉 🔥 👍 ❤️ 👎 💩, or none at all.
- `/status` reports session state, `/fleet` lists omp tmux windows, and all commands sit in the bot menu.
- Context compaction announces itself; retries and model fallbacks show as a provider note on the board and in `/status` rather than a message per session.

## Grading with reactions

React to any message a session sent and the reaction is kept as a grade on it. The scale is +3 🏆 💯 🤩 ❤️‍🔥 🎉 🔥, +2 👍 ❤️ 👏 😍 🥰 👌 🙏 😁 🤣, +1 😎 🤝 🫡 🆒 👀 🤓, 0 🤔 🤨 😐 🤷, -1 🥱 😴 🙈 😢 💔, -2 👎 😨 😱 😭 🤯, -3 💩 🤮 🤡 🤬 😡 🖕. Any other emoji is kept without a grade and returns a reaction error containing the scale.

A grade of -2 or lower on something the agent wrote triggers a redo: an open question gets a restate request carrying the context a phone reader needs; a turn-end status, standing question, snippet or file starts a turn asking for that message redone with the right tool. Bot notices, ended sessions, and closed questions keep their grade without a redo.

Every change of reaction appends one line to `~/.omp/agent/notify-telegram/feedback.jsonl`: `version`, `updateId` (the Telegram update id), `at` (reaction time in ms), `messageId`, `emoji` (reactions now set, empty when you take one back), `previous`, `grade` (lowest graded emoji, `null` when any emoji is outside the scale), `redo`, and `message`, the record of what was sent: `kind` (`status`, `question`, `standing`, `snippet`, `file`, `approval` or `notice`), the `text` as sent, the `session` (omp session id, routing tag, badge emoji, name, working directory) and, for statuses and questions, the `payload` the tool was called with. The last line per message is its current state; sent records live under `notify-telegram/sent/<message id>.json` for ninety days, so feedback remains self-contained after they expire.

## Messaging between sessions

Agents in different live sessions write to each other with `session_message`, addressing a peer by its badge emoji, or by its tag when it has none, and a bare call lists the live sessions. A message reaches a busy peer at its next step without interrupting its tool calls, wakes an idle one, carries an id that an answer quotes in `reply_to`, and appears only in the two transcripts. A chain stops after six hops unless the user prompts one of the sessions in between.

## Dependencies between sessions

Sessions record what they wait on with `session_graph`, and `upstream_launch` links a child to the session that launched it, so the graph keeps a year of dependency chains across restarts. Agents report their own status, and the session holding the Telegram connection polls each pull request on GitHub every ten minutes. An outcome such as a push, a merge or a fix found not needed wakes every session waiting on it, or, when that session has ended, is held and raises a Telegram card offering to resume it. `/deps` sends the graph as a Mermaid diagram rendered by [`mmdc`](https://github.com/mermaid-js/mermaid-cli) with the status of every node, and `/resume` lists the ended sessions with updates waiting.

## Upstream fixes

When a session finds that a bug belongs in a repository this one depends on, it writes the finding up and calls `upstream_launch`. The tool shows a Launch or Cancel card and does nothing until you tap Launch. The branch then goes to the target itself when you own it or have push permission on it, and otherwise to your fork of it, found by its parent whatever it is named, or created when you have none. The tool uses your clone at `~/github/<name>` as its remotes stand, adding a missing remote only under a free name and never re-pointing one, or clones there when there is none. It cuts a worktree on a fresh `upstream/<slug>` branch off the target's latest default branch, carries the finding in, and opens a new omp session in its own tmux tab, told which remote to push to. That session asks what it needs, does the work, self-reviews as the maintainer would, pushes a branch, and sends the compare link and pull-request text, then waits for you to open the PR before it watches CI. The launching session never writes in the upstream repository itself.
