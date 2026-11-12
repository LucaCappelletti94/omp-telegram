# omp-telegram

[![CI](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaCappelletti94/omp-telegram/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/LucaCappelletti94/omp-telegram/graph/badge.svg)](https://codecov.io/gh/LucaCappelletti94/omp-telegram)
[![License](https://img.shields.io/github/license/LucaCappelletti94/omp-telegram)](https://github.com/LucaCappelletti94/omp-telegram/blob/main/LICENSE)

Telegram notifications and remote control for [Oh My Pi](https://github.com/can1357/oh-my-pi) sessions. Turn ends arrive as a short agent-written summary with an urgency light and optional tappable choices whose label starts the next turn; every choice carries a line saying what it does. `ask` questions appear at the terminal and on Telegram at once, and the first answer wins.

Parallel sessions share one bot. Every message opens with the session's badge and then its task, model, and tmux `session:window.pane` when attached, so a phone notification identifies itself and keeps replies routed. The session's own agent chooses the badge: an emoji, a code of 1 to 6 capitals or digits naming the phase or key aspect of the work (`R89`, `FREEZE`), and a label. Emoji and code are each unique among live sessions, and a session is asked every turn until it has both. The omp session is renamed to `emoji CODE: label`, omp's own title card form, so the tmux window label, which shows only about a dozen characters, opens with the code, and the terminal title and omp's resume list show the same badge as Telegram.

## Setup

Use `omp 18.18.3` or newer. Create a bot with [@BotFather](https://t.me/BotFather), then run the setup.

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
- `pinnedDashboard: true`: a pinned message showing every live session, rewritten in place at most every `dashboardSeconds` (default 30) when the text changed. Failed pin attempts retry without reposting the board.
- `userName`: what `ask` options call you, as in "Luca will review the diff". Learned from your Telegram first name on your first message or button press, and a name written here by hand is kept.

Setting `completion.notify` and `ask.notify` to `"off"` in `config.yml` stops omp's bell from flagging tmux windows. Edits apply to running sessions within about fifteen seconds, so no restart is needed.

## Answering

- Tap a button, reply to a session's message, or send a bare message to the last session that notified you; while a question is open, any text to that session answers it.
- Photos reach the agent as images; voice notes, audio files, and documents are saved to disk and handed over as file paths.
- Files are named `<UTC stamp>__<kind>__<session>__<original name>`, incoming ones carrying the Telegram update id; a photo repeats the name in its caption because Telegram drops photo filenames.
- The chat shows a typing status while the session works your answer and an upload status while a file goes up. Delivered messages get a thumbs-up reaction. Red statuses are unpinned when answered, superseded, or closed, with failed cleanup retried across session restarts, and `/hidequestions` clears open question buttons.
- Unroutable messages are refused with an explanation; presses on settled questions get a closure notice.
- Question text renders a Markdown subset: code, fences, bold, italic, strikethrough, spoilers, quotes, links.
- Question options and turn-end buttons name who acts, "Agent will …" or your name, and one saying I, me, you, your, we or us is refused, because a tapped option reads as your own reply and a pronoun there could mean either side.
- Text meant to be pasted elsewhere arrives as its own message ending in one fenced block holding it verbatim; payloads too large for one message are refused rather than cut and go as a file.
- Agents use `notify_message` to list their sent message IDs, edit text or file captions, and delete messages. Edits keep the session head and buttons. Active `ask` messages must be answered or cancelled before editing or deletion.
- While a turn runs, the answer streams into an ephemeral draft bubble with the same head and the tool activity.
- `/stop` aborts the running turn: sent bare it reaches the one session mid-turn and offers a button per session when several are, sent as a reply it stops the session that message belongs to.
- Turn-end summaries report tokens and cost per model, with green summaries offering close-only and close-and-clear actions for the session and its tmux pane. Clearing removes that session's tracked messages and uniquely routed user messages, leaving other sessions and shared messages alone. Telegram's [48-hour deletion limit](https://core.telegram.org/bots/api/methods/deletemessage.md) applies, and anything left behind is reported.
- A turn that ends while one of the session's background jobs still runs is reported at once, says the session waits on that job, and offers no close actions, since closing would end the job.
- The tmux pane option `@omp_state` carries the state omp-tmux colours its bar with, `urgent` for a turn end recorded red, `reply` for a turn end that wants a reply or offers a choice, `sleeping` for a turn end that waits on a background job or on another session that is not finished, `done` for a turn end with nothing to wait on, and `crashed` on the pane of a dead session while its Restore card is open. A session clears the option when it starts, takes input, or shuts down, and a crash clears it when the card is dismissed, the session comes back, or its record expires, only while the pane still reads `crashed`. Outside tmux nothing is written, and a failed write is ignored until the next event.
- A green summary plays the Telegram send effect its agent chose for how the turn went, one of 🎉 🔥 👍 ❤️ 👎 💩, or none at all.
- `/status` reports session state, `/fleet` lists omp tmux windows, and all commands sit in the bot menu.
- `/conduct <name>`, with the task's brief on the lines after it, opens an omp session in a new tmux window that conducts that task. Closing it leaves the task dormant, the same command resumes it, and a bare `/conduct` lists the tasks. Each live session that ends a turn is mentioned to every live conductor once, the conductor invites the ones that belong through a Join or Skip card, and a session that joined reads its tasks and their conductors every turn. A member's `upstream_launch` session joins its tasks too. A member leaves when it is closed or can no longer be restored, and once the last one has left the conductor sends a closing notice and closes.
- A conductor raises what it finds between members, such as two sessions editing the same files, as one card each. Tell the sessions sends its suggested message as a message from the conductor, Resolved and Not a problem settle the card for good, and a reply to the card reaches the conductor. A member that has finished gets a completion card carrying its own close buttons and Not done.
- Members record claims on work and proposed decisions in the task's register before acting, and see what the others hold. The conductor accepts an entry or objects to it, and an objection reaches you as a card to uphold or overrule. An entry the conductor leaves unanswered for ten minutes stands accepted, and a member that leaves frees its open claims.
- Members send their conductor updates on their own. A member silent for four hours, or the limit you ask the conductor for, is checked on through its transcript since its last update, unless it is waiting on you. The conductor also reviews every turn of the member on top of the focus vote.
- Context compaction announces itself; retries and model fallbacks show as a provider note on the board and in `/status` rather than a message per session.

## Grading with reactions

React to any message a session sent and the reaction is kept as a grade on it. The scale is +3 🏆 💯 🤩 ❤️‍🔥 🎉 🔥, +2 👍 ❤️ 👏 😍 🥰 👌 🙏 😁 🤣, +1 😎 🤝 🫡 🆒 👀 🤓, 0 🤔 🤨 😐 🤷, -1 🥱 😴 🙈 😢 💔, -2 👎 😨 😱 😭 🤯, -3 💩 🤮 🤡 🤬 😡 🖕. Any other emoji is kept without a grade and returns a reaction error containing the scale.

A grade of -2 or lower on something the agent wrote triggers a redo: an open question gets a restate request carrying the context a phone reader needs; a turn-end status, standing question, snippet or file starts a turn asking for that message redone with the right tool. Bot notices, ended sessions, and closed questions keep their grade without a redo.

Every change of reaction appends one line to `~/.omp/agent/notify-telegram/feedback.jsonl`: `version`, `updateId` (the Telegram update id), `at` (reaction time in ms), `messageId`, `emoji` (reactions now set, empty when you take one back), `previous`, `grade` (lowest graded emoji, `null` when any emoji is outside the scale), `redo`, and `message`, the record of what was sent: `kind` (`status`, `question`, `standing`, `snippet`, `file`, `approval` or `notice`), the `text` as sent, the `session` (omp session id, routing tag, badge emoji, name, working directory) and, for statuses and questions, the `payload` the tool was called with. The last line per message is its current state; sent records live under `notify-telegram/sent/<message id>.json` for ninety days, so feedback remains self-contained after they expire.

## Messaging between sessions

Agents in different live sessions write to each other with `session_message`, addressing a peer by its badge emoji, or by its tag when it has none, and a bare call lists the live sessions. A message reaches a busy peer at its next step without interrupting its tool calls, wakes an idle one, carries an id that an answer quotes in `reply_to`, and appears only in the two transcripts. A chain stops after twenty hops unless the user prompts one of the sessions in between.

## Priority vote

Every turn end ranks the other live sessions twice through `notify_status`, once for your attention and once for CPU, and `priority_vote` updates either ranking mid-turn. The session holding the Telegram connection tallies the live ballots every thirty seconds with a modified Borda count in which no session ranks itself. The attention order sorts `/status`, `/fleet` and the pinned board, and sets the tmux window option `@omp_vote` to `top` on the winner's window. The CPU order sets `CPUWeight` on each tmux pane's scope through the systemd user manager, from 25 to 400 geometrically with the default 100 at half the attainable points, and gives the default back once the session ends. A window marked `@omp_priority high` in omp-tmux outranks every vote in both orders.

Heavy `bash` commands (cargo builds and tests, `npm test`, `make`, `docker build`) take a lease. One runs at once while fewer than four are out, the machine's pressure stays low, its filesystem has room and no higher-ranked session waits. Otherwise nothing runs and the next grant, in resource-vote order, wakes the session. The `leases` object in the config file overrides `limit`, `cpuPressure`, `memoryPressure`, `ioPressure`, `diskFloor` and `reserveMs`. While memory pressure stays at `memoryPressure` or above, the lower half of the resource vote gets `MemoryHigh` at 110 % of its use, lifted after five minutes under half of it.

## Dependencies between sessions

Sessions record what they wait on with `session_graph`, and `upstream_launch` links a child to the session that launched it, so the graph keeps a year of dependency chains across restarts. Agents report their own status, and the session holding the Telegram connection polls each pull request on GitHub every ten minutes. An outcome such as a push, a merge or a fix found not needed wakes every session waiting on it, or, when that session has ended, is held and raises a Telegram card offering to resume it. `/deps` sends the graph as a Mermaid diagram rendered by [`mmdc`](https://github.com/mermaid-js/mermaid-cli) with the status of every node, and `/resume` lists the ended sessions with updates waiting.

The card names the tmux tab the session ran in. Resume reopens the session at that tab number in its tmux session, the same way Restore does, and delivers its held updates, and the card then names the tab it opened in and drops its buttons. Later keeps the offer open, and No closes it without buttons. Held updates remain available through `/resume` or a manual resume, and a new update raises a fresh card.

`pr_watch` tells a session about pull requests it cares about. `add` reports a pull request's current state and watches it from then on, and the pull request a session names in `session_graph` or pushes from its branch is watched without asking. A merge, a close, each new review, bots included, and the head commit's checks turning red or fully green wake the session with an update written by no one. Once the session has ended, merges, closes and reviews are held for its resume card and CI changes are left out. `remove` stops a watch and `list` shows them. The session holding the Telegram connection fetches every watched pull request once a minute in one GraphQL query.

## Restoring after a crash or reboot

A session that dies without shutting down, whether its omp process was killed or the whole machine went down, is kept aside with its folder, flags, tmux session, tab number and open questions. So is a session that a reboot or poweroff shut down, which systemd reports while it stops the machine, and its red pin stays up. The first omp to start afterwards, or the one holding the Telegram connection within fifteen seconds of a lone death, posts one card listing every session that ended together and the state each was in. A tap on Restore reopens it with `omp --resume` at its old tab number in its tmux session, creating that session detached when a reboot took it and appending the window when another one holds that number. The reopened session takes back its badge, reply routing and standing question. One cut off mid-turn is told what happened, and asks on Telegram whether to continue only when work remains. Dismiss clears the card's buttons and leaves the transcripts for a manual `omp --resume`. A session closed by hand is never offered, nor is a process still running on the same boot, as after a suspend, and the records expire after a week.

## Upstream fixes

`upstream_launch` sends a card offering Launch, Cancel and **Upstreaming has already started**, and returns at once. The session holding the Telegram connection answers the tap, so the card outlives the tool call and the session that asked. Launch preserves existing clone remotes, cuts `upstream/<slug>` from the target's default branch, and opens an `omp` session in a `tmux` tab of the requesting session, using the writable target repository or a fork. The outcome, and any text reply to the card, reach the requesting session, held for its resume card when it has ended. A failed launch keeps its buttons for a retry, an unanswered card expires after seven days, `list` shows the requests and upstream sessions for a repository, and `retract` withdraws a session's own request and deletes its card.
