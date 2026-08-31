import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const CONFIG_PATH = join(AGENT_DIR, "notify-telegram.json");
const STATE_DIR = join(AGENT_DIR, "notify-telegram");
const LOCK_FILE = join(STATE_DIR, "poller.lock");
const LEGACY_LOCK_DIR = join(STATE_DIR, "poller.lock.d");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const PENDING_TOPICS = join(STATE_DIR, "pending-topics.json");
const INBOX_DIR = join(STATE_DIR, "inbox");

const HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 45_000;
const DRAIN_MS = 1_000;
const LONG_POLL_S = 25;
const BUTTON_TEXT_MAX = 60;
const PREVIEW_MAX = 300;
const RECENT_MESSAGE_CAP = 60;
const TELEGRAM_TEXT_MAX = 4096;

/**
 * Single source for stance marker and colour. Telegram button styles offer only
 * red, green and blue, so the middle stance carries its colour in the marker.
 */
const STANCE = {
	preferable: { marker: "(preferable)", style: "success" as const },
	lukewarm: { marker: "\u{1F7E0} (lukewarm)", style: undefined },
	discouraged: { marker: "(discouraged)", style: "danger" as const },
};

const BADGE_PALETTE = [
	"\u{1F98A}", // fox
	"\u{1F419}", // octopus
	"\u{1F335}", // cactus
	"\u{1F3B8}", // guitar
	"\u{1F680}", // rocket
	"\u{1F41D}", // bee
	"\u{1F344}", // mushroom
	"\u{1F9ED}", // compass
	"\u{1F42C}", // dolphin
	"\u{1F3A9}", // top hat
	"\u{1F9F2}", // magnet
	"\u{1F94C}", // curling stone
];

interface Config {
	token: string;
	chatId: number;
	offset: number;
	quietSeconds: number;
	notifyOnTurnEnd: boolean;
}

interface SessionRecord {
	pid: number;
	tag: string;
	name: string;
	topicId: number | null;
	topicName: string;
	cwd: string;
	emoji: string;
	label: string;
	lastNotified: number;
	/** Replying to one of these routes back here. */
	recent: number[];
	/** Standing turn-end question; survives a resume. */
	standing: { id: string; messageId: number | null; labels: string[] } | null;
	heartbeat: number;
}

interface TelegramMessage {
	message_id: number;
	date: number;
	chat: { id: number };
	message_thread_id?: number;
	reply_to_message?: { message_id: number };
	text?: string;
	caption?: string;
}

interface TelegramCallbackQuery {
	id: string;
	data?: string;
	from?: { id: number };
	message?: { message_id: number; chat: { id: number } };
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface InlineButton {
	text: string;
	callback_data: string;
	style?: "danger" | "success" | "primary";
}

interface AskOption {
	label: string;
	description?: string;
	preview?: string;
	/** Workable, but not the pick. */
	lukewarm?: boolean;
	/** Present only for contrast. */
	discouraged?: boolean;
}

interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	header?: string;
	multi?: boolean;
	recommended?: number;
}

/** Preferable wins over discouraged, which wins over lukewarm, when a caller marks contradictions. */
function stanceOf(question: AskQuestion, option: AskOption, index: number) {
	if (question.recommended === index) return STANCE.preferable;
	if (option.discouraged === true) return STANCE.discouraged;
	if (option.lukewarm === true) return STANCE.lukewarm;
	return null;
}

interface AskResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

interface PendingAsk {
	askId: string;
	head: string;
	context: string;
	questions: AskQuestion[];
	index: number;
	messageId: number | null;
	selected: Set<string>[];
	custom: Array<string | undefined>;
	awaitingText: boolean;
	finish: (results: AskResult[]) => void;
}

interface TurnStatus {
	text: string;
	urgency: "green" | "orange" | "red";
	question?: string;
	options?: string[];
}

interface InboxEntry {
	kind: "text" | "callback";
	value: string;
}

/** Temp plus rename: a reader in another omp process must never see a torn file. */
function writeFileAtomic(path: string, content: string, mode?: number): void {
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, content, mode === undefined ? {} : { mode });
	renameSync(temp, path);
}

function loadConfig(): Config | null {
	if (!existsSync(CONFIG_PATH)) return null;
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const raw = parsed as Record<string, unknown>;
	if (typeof raw.token !== "string" || raw.token.length < 20) return null;
	if (typeof raw.chatId !== "number") return null;
	return {
		token: raw.token,
		chatId: raw.chatId,
		offset: typeof raw.offset === "number" ? raw.offset : 0,
		quietSeconds: typeof raw.quietSeconds === "number" ? raw.quietSeconds : 45,
		notifyOnTurnEnd: raw.notifyOnTurnEnd !== false,
	};
}

function persistOffset(offset: number): void {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return; // Torn read; the next poll cycle persists again.
	}
	if (parsed === null || typeof parsed !== "object") return;
	const next = { ...(parsed as Record<string, unknown>), offset };
	writeFileAtomic(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

/** Markdown subset to Telegram HTML. Code is stashed first so emphasis cannot touch it. */
function toTelegramHtml(source: string): string {
	const blocks: string[] = [];
	const stash = (html: string): string => {
		blocks.push(html);
		return `\u0000${blocks.length - 1}\u0000`;
	};
	const escapeHtml = (text: string): string =>
		text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

	let work = source.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
		const opener = language.length > 0 ? `<pre><code class="language-${language}">` : "<pre>";
		const closer = language.length > 0 ? "</code></pre>" : "</pre>";
		return stash(`${opener}${escapeHtml(code.replace(/\n$/, ""))}${closer}`);
	});
	work = work.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

	work = escapeHtml(work);
	// Headings have no Telegram equivalent and otherwise render as literal hash marks.
	work = work.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	work = work.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
	work = work.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
	work = work.replace(/~~([^\n~]+)~~/g, "<s>$1</s>");
	work = work.replace(/\|\|([^\n|]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
	// Single-delimiter emphasis runs last so it cannot eat the doubled forms above. Both require a
	// boundary before the opener, which keeps snake_case identifiers and multiplication intact.
	work = work.replace(/(^|[\s(])\*([^\n*]+)\*(?=[\s).,:!?]|$)/g, "$1<i>$2</i>");
	work = work.replace(/(^|[\s(])_([^\n_]+)_(?=[\s).,:!?]|$)/g, "$1<i>$2</i>");
	work = work.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
	work = work.replace(/<\/blockquote>\n<blockquote>/g, "\n");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the stash marker
	return work.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "");
}

interface TelegramFailure {
	method: string;
	status: number;
	description: string;
}

async function callTelegramRaw<T>(
	config: Config,
	method: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	onFailure: (failure: TelegramFailure) => void,
	attempt = 0,
): Promise<T | null> {
	const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const payload: unknown = await response.json().catch(() => null);
	const envelope =
		payload !== null && typeof payload === "object"
			? (payload as { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } })
			: null;
	// Telegram throttles a bot to roughly one message per second per chat. Several sessions ending a
	// turn together will hit it, and dropping those notifications silently is the wrong answer.
	const retryAfter = envelope?.parameters?.retry_after;
	if (response.status === 429 && typeof retryAfter === "number" && retryAfter <= 30 && attempt === 0) {
		await new Promise((resolve) => setTimeout(resolve, (retryAfter + 0.5) * 1000));
		return await callTelegramRaw<T>(config, method, body, timeoutMs, onFailure, 1);
	}
	if (!response.ok || envelope === null || envelope.ok !== true) {
		onFailure({
			method,
			status: response.status,
			description: typeof envelope?.description === "string" ? envelope.description : "no description",
		});
		return null;
	}
	return envelope.result as T;
}

/**
 * Telegram offers no button sizing: a row spans the message width, split equally among its buttons.
 * Adaptive size therefore means adaptive packing: short labels share a row, long labels get a full
 * row. Two-up when both fit 16 cells and 26 combined, three-up when all fit 9, measured on the rendered text.
 */
function packRows(buttons: InlineButton[]): InlineButton[][] {
	const rows: InlineButton[][] = [];
	let row: InlineButton[] = [];
	for (const button of buttons) {
		const width = [...button.text].length;
		const total = row.reduce((n, b) => n + [...b.text].length, 0) + width;
		const canJoin =
			(row.length === 1 && width <= 16 && total <= 26) ||
			(row.length === 2 && width <= 9 && total <= 24 && row.every((b) => [...b.text].length <= 9));
		if (row.length === 0 || canJoin) {
			row.push(button);
		} else {
			rows.push(row);
			row = [button];
		}
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

/** Renders the keyboard for one question. Selected labels get a check mark so multi-select reads correctly. */
function questionKeyboard(ask: PendingAsk, question: AskQuestion): InlineButton[][] {
	const chosen = ask.selected[ask.index] ?? new Set<string>();
	const optionButtons = question.options.map((option, optionIndex) => {
		const mark = question.multi === true && chosen.has(option.label) ? "[x] " : "";
		const stance = stanceOf(question, option, optionIndex);
		const suffix = stance === null ? "" : ` ${stance.marker}`;
		const button: InlineButton = {
			text: `${mark}${option.label}${suffix}`.slice(0, BUTTON_TEXT_MAX),
			callback_data: `o:${ask.askId}:${ask.index}:${optionIndex}`,
		};
		if (stance?.style !== undefined) button.style = stance.style;
		return button;
	});
	const tail: InlineButton[] = [{ text: "Type an answer", callback_data: `t:${ask.askId}:${ask.index}` }];
	if (question.multi === true) {
		tail.unshift({ text: "Done", callback_data: `d:${ask.askId}:${ask.index}`, style: "success" });
	}
	return [...packRows(optionButtons), ...packRows(tail)];
}

export default function notifyTelegram(pi: ExtensionAPI): void {
	const z = pi.zod;

	let config: Config | null = null;
	let sessionTag = "";
	let sessionId = "";
	let lastLocalInput = Date.now();
	let pollInFlight = false;
	let drainInFlight = false;
	let askSequence = 0;
	let pendingAsk: PendingAsk | null = null;
	let unsubscribeInput: (() => void) | null = null;
	let turnSummary: TurnStatus | null = null;
	let standingSeq = 0;
	let standingQuestion: { id: string; messageId: number | null; labels: string[] } | null = null;
	let statusBlockUsed = false;
	let badgeEmoji = "";
	let badgeOverride = "";
	let topicId: number | null = null;
	let topicName = "";
	const recentMessages: number[] = [];
	let lastNotifiedAt = 0;

	/** A rejected detached promise is fatal in omp. */
	function detach(work: Promise<unknown>, label: string): void {
		work.catch((error) =>
			pi.logger.warn(`notify-telegram: ${label} failed`, {
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	function callTelegram<T>(
		cfg: Config,
		method: string,
		body: Record<string, unknown>,
		timeoutMs: number,
	): Promise<T | null> {
		return callTelegramRaw<T>(cfg, method, body, timeoutMs, (failure) =>
			pi.logger.warn("telegram call failed", failure),
		);
	}

	/** A rejected HTML send retries as plain text; the size limit is on the rendered form. */
	async function sendOrEdit(
		cfg: Config,
		method: "sendMessage" | "editMessageText",
		body: Record<string, unknown>,
		plain: string,
	): Promise<TelegramMessage | null> {
		const quiet = { link_preview_options: { is_disabled: true } };
		let source = plain;
		while (toTelegramHtml(source).length > TELEGRAM_TEXT_MAX && source.length > 200) {
			source = source.slice(0, Math.floor(source.length * 0.8));
		}
		let sent = await callTelegram<TelegramMessage>(
			cfg,
			method,
			{ ...quiet, ...body, text: toTelegramHtml(source), parse_mode: "HTML" },
			15_000,
		);
		if (sent === null) {
			pi.logger.warn("telegram: rich send rejected, retrying as plain text", { method });
			sent = await callTelegram<TelegramMessage>(cfg, method, { ...quiet, ...body, text: source }, 15_000);
		}
		if (method === "sendMessage" && typeof sent?.message_id === "number") {
			recentMessages.push(sent.message_id);
			if (recentMessages.length > RECENT_MESSAGE_CAP)
				recentMessages.splice(0, recentMessages.length - RECENT_MESSAGE_CAP);
		}
		return sent;
	}

	function writeSessionRecord(ctx: ExtensionContext): void {
		const record: SessionRecord = {
			pid: process.pid,
			tag: sessionTag,
			name: ctx.sessionManager.getSessionName() ?? "",
			topicId,
			topicName,
			cwd: ctx.cwd,
			emoji: badgeEmoji,
			label: badgeOverride,
			lastNotified: lastNotifiedAt,
			recent: [...recentMessages],
			standing: standingQuestion,
			heartbeat: Date.now(),
		};
		writeFileAtomic(join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(record));
	}

	function readSessionRecord(id: string): SessionRecord | null {
		const path = join(SESSIONS_DIR, `${id}.json`);
		if (!existsSync(path)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			return parsed as SessionRecord;
		} catch {
			return null;
		}
	}

	function allRecords(): Array<{ id: string; record: SessionRecord }> {
		if (!existsSync(SESSIONS_DIR)) return [];
		const out: Array<{ id: string; record: SessionRecord }> = [];
		for (const entry of readdirSync(SESSIONS_DIR)) {
			if (!entry.endsWith(".json")) continue;
			const record = readSessionRecord(entry.slice(0, -5));
			if (record !== null) out.push({ id: entry.slice(0, -5), record });
		}
		return out;
	}

	function otherLiveRecords(): SessionRecord[] {
		return allRecords()
			.filter(({ id, record }) => id !== sessionId && Date.now() - record.heartbeat <= LOCK_STALE_MS)
			.map(({ record }) => record);
	}

	function claimBadge(): string {
		const taken = new Set(otherLiveRecords().map((record) => record.emoji));
		const previous = readSessionRecord(sessionId)?.emoji;
		if (previous !== undefined && previous.length > 0 && !taken.has(previous)) return previous;
		const free = BADGE_PALETTE.find((candidate) => !taken.has(candidate));
		if (free !== undefined) return free;
		let hash = 0;
		for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) % BADGE_PALETTE.length;
		return BADGE_PALETTE[hash] ?? BADGE_PALETTE[0] ?? "";
	}

	/** Session id prefixes are timestamps and collide; routing needs a random token. */
	function claimTag(): string {
		const taken = new Set(otherLiveRecords().map((record) => record.tag));
		const previous = readSessionRecord(sessionId)?.tag;
		if (previous !== undefined && /^[a-z0-9]{5}$/u.test(previous) && !taken.has(previous)) return previous;
		for (let attempt = 0; attempt < 64; attempt++) {
			const candidate = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
			if (!taken.has(candidate)) return candidate;
		}
		return Math.random().toString(36).slice(2, 7).padEnd(5, "0");
	}

	function reapDeadSessions(): void {
		if (!existsSync(SESSIONS_DIR)) return;
		for (const entry of readdirSync(SESSIONS_DIR)) {
			if (!entry.endsWith(".json")) continue;
			const id = entry.slice(0, -5);
			if (id === sessionId) continue;
			const record = readSessionRecord(id);
			// A live session refreshes its heartbeat every 15 seconds, so a stale one is gone.
			if (record !== null && Date.now() - record.heartbeat <= LOCK_STALE_MS) continue;
			unlinkSync(join(SESSIONS_DIR, entry));
			rmSync(join(INBOX_DIR, id), { recursive: true, force: true });
		}
	}

	function badge(ctx: ExtensionContext): string {
		const folder =
			ctx.cwd
				.split("/")
				.filter((part) => part.length > 0)
				.pop() ?? ctx.cwd;
		const detail = badgeOverride.length > 0 ? badgeOverride : (ctx.sessionManager.getSessionName() ?? "");
		return `${badgeEmoji} ${folder} \u00B7 ${detail.length > 0 ? detail.slice(0, 60) : sessionTag}`;
	}

	function threaded(extra: Record<string, unknown>): Record<string, unknown> {
		if (config === null) return extra;
		const base = { chat_id: config.chatId, ...extra };
		return topicId === null ? base : { ...base, message_thread_id: topicId };
	}

	/** Re-read per message; windows get reordered. */
	function tmuxLocation(): string | null {
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return null;
		try {
			const out = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{window_index}"], { timeout: 2000 })
				.toString()
				.trim();
			return out.length > 0 ? out : null;
		} catch {
			return null;
		}
	}

	function lastAssistantTail(ctx: ExtensionContext): string {
		try {
			if (typeof ctx.sessionManager.getBranch !== "function") return "";
			const branch = ctx.sessionManager.getBranch() as unknown[];
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (let j = content.length - 1; j >= 0; j--) {
					const block = content[j] as { type?: unknown; text?: unknown };
					if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
						const tail =
							block.text
								.trim()
								.split(/\n{2,}/)
								.at(-1) ?? "";
						return tail.length > 600 ? `${tail.slice(0, 600)}...` : tail;
					}
				}
			}
		} catch {}
		return "";
	}

	function withHead(ctx: ExtensionContext, title: string, body: string): string {
		const head = topicId === null ? `${badge(ctx)}\n\n` : "";
		return `${head}**${title}**\n${body}`;
	}

	/** `thread` overrides the session topic for replies into a foreign thread. */
	async function serviceNotice(text: string, thread?: number): Promise<void> {
		if (config === null) return;
		const body: Record<string, unknown> =
			thread === undefined
				? threaded({ text: `\u{1F535} ${text}` })
				: { chat_id: config.chatId, message_thread_id: thread, text: `\u{1F535} ${text}` };
		await callTelegram(config, "sendMessage", body, 15_000);
	}

	async function notify(ctx: ExtensionContext, title: string, body: string): Promise<void> {
		if (config === null) return;
		await sendOrEdit(config, "sendMessage", threaded({}), withHead(ctx, title, body));
		lastNotifiedAt = Date.now();
		writeSessionRecord(ctx);
	}

	async function ensureTopic(ctx: ExtensionContext): Promise<void> {
		if (config === null) return;
		const previous = readSessionRecord(sessionId);
		if (typeof previous?.topicId === "number") {
			topicId = previous.topicId;
			topicName = previous.topicName;
			return;
		}
		const colours = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
		const index = Math.max(0, BADGE_PALETTE.indexOf(badgeEmoji)) % colours.length;
		const name = badge(ctx).slice(0, 128);
		const created = await callTelegram<unknown>(
			config,
			"createForumTopic",
			{ chat_id: config.chatId, name, icon_color: colours[index] },
			15_000,
		);
		const thread =
			created !== null && typeof created === "object" && "message_thread_id" in created
				? created.message_thread_id
				: undefined;
		if (typeof thread !== "number") {
			pi.logger.debug("notify-telegram: no forum topic, falling back to flat messages");
			return;
		}
		topicId = thread;
		topicName = name;
	}

	/** The session title lands after the first turn. */
	async function renameTopicIfStale(ctx: ExtensionContext): Promise<void> {
		if (config === null || topicId === null) return;
		const name = badge(ctx).slice(0, 128);
		if (name === topicName) return;
		topicName = name;
		await callTelegram(config, "editForumTopic", { chat_id: config.chatId, message_thread_id: topicId, name }, 15_000);
	}

	function readPendingTopics(): number[] {
		if (!existsSync(PENDING_TOPICS)) return [];
		try {
			const parsed: unknown = JSON.parse(readFileSync(PENDING_TOPICS, "utf8"));
			return Array.isArray(parsed) ? parsed.filter((entry): entry is number => typeof entry === "number") : [];
		} catch {
			return [];
		}
	}

	/** Shutdown cannot await; the next start sweeps the queue. */
	async function sweepPendingTopics(): Promise<void> {
		if (config === null) return;
		const pending = readPendingTopics();
		if (pending.length === 0) return;
		writeFileAtomic(PENDING_TOPICS, "[]");
		for (const id of pending) {
			await callTelegram(config, "deleteForumTopic", { chat_id: config.chatId, message_thread_id: id }, 15_000);
		}
	}

	/** One poller only, or Telegram 409s. Atomic `wx` create; ownership re-read, never cached. */
	function readLock(): { sessionId: string; pid: number; heartbeat: number } | null {
		if (!existsSync(LOCK_FILE)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			const raw = parsed as { sessionId?: unknown; pid?: unknown; heartbeat?: unknown };
			if (typeof raw.sessionId !== "string" || typeof raw.heartbeat !== "number") return null;
			return { sessionId: raw.sessionId, pid: typeof raw.pid === "number" ? raw.pid : 0, heartbeat: raw.heartbeat };
		} catch {
			return null;
		}
	}

	function acquireLock(): boolean {
		const mine = JSON.stringify({ sessionId, pid: process.pid, heartbeat: Date.now() });
		try {
			writeFileSync(LOCK_FILE, mine, { flag: "wx" });
		} catch {
			const held = readLock();
			if (held !== null && Date.now() - held.heartbeat < LOCK_STALE_MS) return false;
			try {
				unlinkSync(LOCK_FILE);
			} catch {}
			try {
				writeFileSync(LOCK_FILE, mine, { flag: "wx" });
			} catch {
				return false;
			}
		}
		return readLock()?.sessionId === sessionId;
	}

	function ownsLock(): boolean {
		return readLock()?.sessionId === sessionId;
	}

	function refreshLock(): void {
		if (!ownsLock()) return;
		writeFileAtomic(LOCK_FILE, JSON.stringify({ sessionId, pid: process.pid, heartbeat: Date.now() }));
	}

	function releaseLock(): void {
		if (!ownsLock()) return;
		try {
			unlinkSync(LOCK_FILE);
		} catch {}
	}

	/** Topic, then replied-to message, then recency. Unresolvable targets are refused, not guessed. */
	function routeMessage(thread: number | undefined, replyTo: number | undefined): string | null {
		const live = allRecords().filter(({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS);
		const byReply =
			replyTo === undefined ? null : (live.find(({ record }) => record.recent?.includes(replyTo) === true)?.id ?? null);
		if (thread !== undefined) {
			return live.find(({ record }) => record.topicId === thread)?.id ?? byReply;
		}
		if (replyTo !== undefined) return byReply;
		let best: { id: string; lastNotified: number } | null = null;
		for (const { id, record } of live) {
			if (best === null || record.lastNotified > best.lastNotified) best = { id, lastNotified: record.lastNotified };
		}
		return best === null ? null : best.id;
	}

	function routeByAskId(askId: string): string | null {
		const tag = askId.split("-")[0] ?? "";
		if (tag.length === 0) return null;
		return (
			allRecords().find(({ record }) => record.tag === tag && Date.now() - record.heartbeat <= LOCK_STALE_MS)?.id ??
			null
		);
	}

	function deliver(target: string, updateId: number, entry: InboxEntry): void {
		const dir = join(INBOX_DIR, target);
		mkdirSync(dir, { recursive: true });
		writeFileAtomic(join(dir, `${updateId}.json`), JSON.stringify(entry));
	}

	async function pollOnce(): Promise<void> {
		if (config === null || pollInFlight) return;
		pollInFlight = true;
		try {
			const updates = await callTelegram<TelegramUpdate[]>(
				config,
				"getUpdates",
				{ offset: config.offset, timeout: LONG_POLL_S, allowed_updates: ["message", "callback_query"] },
				(LONG_POLL_S + 10) * 1000,
			);
			if (updates === null || updates.length === 0) return;
			let highest = config.offset - 1;
			for (const update of updates) {
				highest = Math.max(highest, update.update_id);

				const callback = update.callback_query;
				if (callback !== undefined && callback.data !== undefined) {
					if (callback.message?.chat.id !== config.chatId || callback.from?.id !== config.chatId) {
						pi.logger.warn("telegram: rejected a button press from an unexpected origin", {
							chat: callback.message?.chat.id,
							from: callback.from?.id,
						});
						continue;
					}
					await callTelegram(config, "answerCallbackQuery", { callback_query_id: callback.id }, 10_000);
					const owner = routeByAskId(callback.data.split(":")[1] ?? "");
					if (owner !== null) deliver(owner, update.update_id, { kind: "callback", value: callback.data });
					continue;
				}

				const message = update.message;
				if (message === undefined) continue;
				if (message.chat.id !== config.chatId) {
					pi.logger.warn("telegram: rejected a message from an unexpected chat", { chat: message.chat.id });
					continue;
				}
				const text = message.text ?? message.caption;
				if (text === undefined || text.length === 0) {
					await serviceNotice(
						"Only text reaches the agent. Add a caption, or send the content as text.",
						message.message_thread_id,
					);
					continue;
				}
				const thread = message.message_thread_id;
				const replyTo = message.reply_to_message?.message_id;

				const target = routeMessage(thread, replyTo);
				if (target === null) {
					await serviceNotice(
						"No live omp session owns that message, so it was dropped. Reply to a message from the session you mean.",
						thread,
					);
					continue;
				}
				deliver(target, update.update_id, { kind: "text", value: text });
			}
			config.offset = highest + 1;
			persistOffset(config.offset);
		} catch (error) {
			pi.logger.debug("telegram poll failed", { error: error instanceof Error ? error.message : String(error) });
		} finally {
			pollInFlight = false;
		}
	}

	async function presentQuestion(ask: PendingAsk, edit: boolean): Promise<void> {
		if (config === null) return;
		const question = ask.questions[ask.index];
		if (question === undefined) return;
		// An option appears in the body only when it adds something beyond its button label.
		const blocks: string[] = [];
		if (ask.head.length > 0 && topicId === null) blocks.push(ask.head);
		const where = tmuxLocation();
		const position = ask.questions.length > 1 ? ` ${ask.index + 1} of ${ask.questions.length}` : "";
		blocks.push(`\u{1F534} Input needed${position}${where === null ? "" : ` (tmux ${where})`}`);
		const header = question.header?.trim() ?? "";
		blocks.push(header.length > 0 ? `**${header}**\n${question.question}` : question.question);
		if (ask.context.length > 0) blocks.push(ask.context);
		for (const [index, option] of question.options.entries()) {
			const description = option.description?.trim() ?? "";
			const preview = option.preview?.trim() ?? "";
			const stance = stanceOf(question, option, index);
			if (description.length === 0 && preview.length === 0 && stance === null) continue;
			const lines = [stance === null ? `**${option.label}**` : `**${option.label}** ${stance.marker}`];
			if (description.length > 0) lines.push(description);
			if (preview.length > 0) {
				const clipped = preview.slice(0, PREVIEW_MAX);
				lines.push(`\`\`\`\n${clipped}\n\`\`\``);
				if (preview.length > PREVIEW_MAX) lines.push("(preview truncated)");
			}
			blocks.push(lines.join("\n"));
		}
		const body = blocks.join("\n\n");
		const markup = { inline_keyboard: questionKeyboard(ask, question) };

		if (edit && ask.messageId !== null) {
			await sendOrEdit(
				config,
				"editMessageText",
				{ chat_id: config.chatId, message_id: ask.messageId, reply_markup: markup },
				body,
			);
			return;
		}
		const sentMessage = await sendOrEdit(config, "sendMessage", threaded({ reply_markup: markup }), body);
		ask.messageId = sentMessage?.message_id ?? null;
	}

	/** The empty keyboard is deliberate: clearing by omission is undocumented. */
	async function closeAskMessage(messageId: number | null, text: string): Promise<void> {
		if (config === null || messageId === null) return;
		await sendOrEdit(
			config,
			"editMessageText",
			{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
			text,
		);
	}

	/** Blocks nothing: a press starts the next turn. Only the latest stands. */
	async function sendStandingQuestion(
		ctx: ExtensionContext,
		title: string,
		recorded: { text: string; question?: string; options?: string[] },
	): Promise<void> {
		if (config === null || recorded.options === undefined) return;
		const superseded = standingQuestion;
		standingSeq += 1;
		const id = `${sessionTag}-n${standingSeq.toString(36)}`;
		const body = withHead(
			ctx,
			title,
			`${recorded.text}${recorded.question === undefined ? "" : `\n\n${recorded.question}`}`,
		);
		const keyboard = packRows(
			recorded.options.map((label, index) => ({
				text: label.slice(0, BUTTON_TEXT_MAX),
				callback_data: `c:${id}:${index}`,
			})),
		);
		const sent = await sendOrEdit(
			config,
			"sendMessage",
			threaded({ reply_markup: { inline_keyboard: keyboard } }),
			body,
		);
		standingQuestion = { id, messageId: sent?.message_id ?? null, labels: recorded.options };
		lastNotifiedAt = Date.now();
		writeSessionRecord(ctx);
		if (superseded !== null) {
			await closeAskMessage(superseded.messageId, "Superseded by a newer question.");
		}
	}

	function collectResults(ask: PendingAsk): AskResult[] {
		return ask.questions.map((question, index) => ({
			id: question.id,
			question: question.question,
			options: question.options.map((option) => option.label),
			multi: question.multi ?? false,
			selectedOptions: [...(ask.selected[index] ?? new Set<string>())],
			customInput: ask.custom[index],
		}));
	}

	async function advance(ask: PendingAsk): Promise<void> {
		if (config === null) return;
		const answered = ask.questions[ask.index];
		const chosen = [...(ask.selected[ask.index] ?? new Set<string>())];
		const shown = ask.custom[ask.index] ?? (chosen.length === 0 ? "no selection" : chosen.join(", "));
		if (answered !== undefined) {
			await closeAskMessage(ask.messageId, `${answered.question}\n\n**Answered:** ${shown}`);
		}
		ask.messageId = null;
		ask.index += 1;
		if (ask.index >= ask.questions.length) {
			ask.finish(collectResults(ask));
			return;
		}
		await presentQuestion(ask, false);
	}

	async function applyCallback(ask: PendingAsk, payload: string): Promise<void> {
		const [action, tag, rawIndex, rawOption] = payload.split(":");
		if (tag !== ask.askId || Number.parseInt(rawIndex ?? "", 10) !== ask.index) return;
		const question = ask.questions[ask.index];
		if (question === undefined) return;

		if (action === "t") {
			ask.awaitingText = true;
			if (config !== null) {
				await sendOrEdit(
					config,
					"sendMessage",
					threaded({ reply_markup: { force_reply: true, input_field_placeholder: "Your answer" } }),
					`Type your answer to: ${question.question}`,
				);
			}
			return;
		}
		if (action === "d") {
			await advance(ask);
			return;
		}
		if (action !== "o") return;

		const optionIndex = Number.parseInt(rawOption ?? "", 10);
		const label = question.options[optionIndex]?.label;
		if (label === undefined) return;
		const selected = ask.selected[ask.index] ?? new Set<string>();
		if (question.multi === true) {
			if (selected.has(label)) selected.delete(label);
			else selected.add(label);
			ask.selected[ask.index] = selected;
			await presentQuestion(ask, true);
			return;
		}
		ask.selected[ask.index] = new Set([label]);
		await advance(ask);
	}

	/** Sequential: two taps in one poll batch must see each other's state. */
	async function drainInbox(): Promise<void> {
		if (drainInFlight) return;
		drainInFlight = true;
		try {
			const dir = join(INBOX_DIR, sessionId);
			if (!existsSync(dir)) return;
			const names = readdirSync(dir)
				.filter((entry) => entry.endsWith(".json"))
				.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
			for (const name of names) {
				const path = join(dir, name);
				let raw = "";
				try {
					raw = readFileSync(path, "utf8");
				} finally {
					try {
						unlinkSync(path);
					} catch {}
				}
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(raw);
				} catch {
					pi.logger.warn("notify-telegram: discarded an unparseable inbox entry", { name });
					continue;
				}
				if (parsed === null || typeof parsed !== "object") continue;
				const entry = parsed as Partial<InboxEntry>;
				if (typeof entry.value !== "string" || entry.value.length === 0) continue;

				const ask = pendingAsk;
				if (entry.kind === "callback" && entry.value.startsWith("c:")) {
					const [, choiceId, rawIndex] = entry.value.split(":");
					const standing = standingQuestion;
					if (standing !== null && standing.id === choiceId) {
						const label = standing.labels[Number.parseInt(rawIndex ?? "", 10)];
						standingQuestion = null;
						if (label !== undefined) {
							await closeAskMessage(standing.messageId, `**Chosen:** ${label}`);
							pi.sendUserMessage(label);
						}
					} else {
						await serviceNotice("That question is closed. It was superseded or already answered.");
					}
					continue;
				}
				if (entry.kind === "callback") {
					if (ask !== null) await applyCallback(ask, entry.value);
					else await serviceNotice("That question is closed. It was answered or cancelled at the terminal.");
					continue;
				}
				if (ask?.awaitingText) {
					ask.awaitingText = false;
					ask.custom[ask.index] = entry.value;
					ask.selected[ask.index] = new Set<string>();
					await advance(ask);
					continue;
				}
				pi.sendUserMessage(entry.value, { deliverAs: "steer" });
			}
		} finally {
			drainInFlight = false;
		}
	}

	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the interactive user one or more questions. Answerable at the terminal or from Telegram, whichever answers first. Set `context` when the question cannot be judged from the option list alone, for example the finding that prompted it or what each alternative costs. Context is shown in both places. Question, option and context text render as Markdown on Telegram. Supported: `inline code` for identifiers, paths and values, triple-backtick fences with a language for multi-line code, **bold**, *italic* or _italic_, ~~strikethrough~~, ||spoiler||, a leading angle bracket for a quoted line, a leading hash for a heading, and [label](https://url) links. Tables, bullet nesting and anything else render as plain text, so prefer a fenced block for tabular output. Mark desirability so a choice reads at a glance, as a three colour semaphore: set `recommended` to the index of the one option you would take, set `lukewarm` on an option that would work but that you would not pick, and set `discouraged` on an option offered only for contrast. Preferable renders green, lukewarm carries an orange marker, and discouraged renders red, all labelled, on Telegram and in the terminal. Leave every mark unset for options that are genuinely equivalent.",
		approval: "read",
		strict: true,
		parameters: z.object({
			questions: z
				.array(
					z.object({
						id: z.string(),
						question: z.string(),
						options: z.array(
							z.object({
								label: z.string(),
								description: z.string().optional(),
								preview: z.string().optional(),
								discouraged: z.boolean().optional(),
								lukewarm: z.boolean().optional(),
							}),
						),
						header: z.string().optional(),
						multi: z.boolean().optional(),
						recommended: z.number().optional(),
					}),
				)
				.min(1),
			context: z.string().optional(),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const invoke = ctx.invokeTool;
			if (invoke === undefined) throw new Error("Ask tool requires interactive mode");
			const questions = params.questions as AskQuestion[];
			const context = typeof params.context === "string" ? params.context.trim() : "";
			// The native tool is strict: `context` rides inside the first question instead.
			const nativeParams = {
				questions: questions.map((question, index) => ({
					...question,
					question: index === 0 && context.length > 0 ? `${context}\n\n${question.question}` : question.question,
					options: question.options.map((option, optionIndex) => {
						const { discouraged, lukewarm, ...rest } = option;
						if (discouraged !== true && lukewarm !== true) return rest;
						const stance = stanceOf(question, option, optionIndex);
						if (stance === null || stance === STANCE.preferable) return rest;
						const description = rest.description?.trim() ?? "";
						return {
							...rest,
							description: description.length > 0 ? `${stance.marker} ${description}` : stance.marker,
						};
					}),
				})),
			};
			if (config === null) return await invoke(nativeParams, { signal, onUpdate });

			askSequence += 1;
			const remote = Promise.withResolvers<AskResult[]>();
			const ask: PendingAsk = {
				askId: `${sessionTag}-${askSequence.toString(36)}`,
				head: badge(ctx),
				context,
				questions,
				index: 0,
				messageId: null,
				selected: questions.map(() => new Set<string>()),
				custom: questions.map(() => undefined),
				awaitingText: false,
				finish: remote.resolve,
			};
			pendingAsk = ask;
			await presentQuestion(ask, false);
			lastNotifiedAt = Date.now();
			writeSessionRecord(ctx);

			const abortLocal = new AbortController();
			const localSignal = signal === undefined ? abortLocal.signal : AbortSignal.any([signal, abortLocal.signal]);
			const local = invoke(nativeParams, { signal: localSignal, onUpdate }).then((value) => ({
				kind: "local" as const,
				value,
			}));
			void local.catch(() => undefined);
			const answered = remote.promise.then((results) => ({ kind: "remote" as const, results }));

			try {
				const winner = await Promise.race([local, answered]);
				if (winner.kind === "local") {
					detach(closeAskMessage(ask.messageId, "Answered at the terminal."), "terminal-answer edit");
					return winner.value;
				}

				abortLocal.abort();
				// Restate question and context: the transcript is their only record now.
				const lines: string[] = [];
				if (context.length > 0) lines.push(`Context given: ${context}`);
				for (const result of winner.results) {
					const chosen = result.selectedOptions.join(", ") || (result.customInput ?? "no answer");
					lines.push(`${result.question}\n  answered: ${chosen}`);
				}
				lines.push("(answered from Telegram)");
				return {
					content: [{ type: "text", text: lines.join("\n\n") }],
					details: winner.results.length === 1 ? winner.results[0] : { results: winner.results },
				};
			} catch (error) {
				const aborted = error instanceof Error && /cancel|abort/iu.test(error.message);
				await closeAskMessage(
					ask.messageId,
					aborted ? "Cancelled at the terminal." : "This question is no longer active.",
				);
				throw error;
			} finally {
				pendingAsk = null;
			}
		},
	});

	pi.registerTool({
		name: "notify_status",
		label: "Notify Status",
		description:
			"Record the turn-end Telegram notification, which is all the user sees when away from the terminal. Call it once, immediately before finishing a turn. `summary`: one or two sentences in plain words stating what was done and what stands open, Markdown subset allowed. Be proactive about what comes next: name the concrete next steps when some exist, and state plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. `urgency`: green when done and idle, orange when a reply is wanted, red when blocked on the user. Whenever any user action is wanted, also set `question` and 2 to 6 short `options` drawn from those real next steps (for example Continue, Review the diff, Stop here): they become tappable buttons, the tapped label starts the next turn, and the most likely choice goes first. Omit `question` and `options` when there is genuinely nothing to ask, never pad with filler choices.",
		approval: "read",
		strict: true,
		parameters: z.object({
			summary: z.string(),
			urgency: z.string(),
			question: z.string().optional(),
			options: z.array(z.string()).optional(),
		}),
		async execute(_toolCallId, params) {
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";
			const raw = typeof params.urgency === "string" ? params.urgency.trim().toLowerCase() : "";
			const urgency = raw === "red" || raw === "orange" || raw === "green" ? raw : "green";
			if (summary.length === 0) {
				return { content: [{ type: "text", text: "Error: summary must not be empty" }], isError: true };
			}
			const labels = Array.isArray(params.options)
				? params.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
				: [];
			if (Array.isArray(params.options) && (labels.length < 2 || labels.length > 6)) {
				return { content: [{ type: "text", text: "Error: options must be 2 to 6 short labels" }], isError: true };
			}
			turnSummary = {
				text: summary.slice(0, 900),
				urgency,
				question:
					typeof params.question === "string" && params.question.trim().length > 0 ? params.question.trim() : undefined,
				options: labels.length > 0 ? labels : undefined,
			};
			return {
				content: [{ type: "text", text: `Status recorded (${urgency}${labels.length > 0 ? ", with choices" : ""}).` }],
				details: { urgency, options: labels },
			};
		},
	});

	pi.registerTool({
		name: "session_badge",
		label: "Session Badge",
		description:
			"Change how this session identifies itself in Telegram notifications. `emoji` replaces the badge emoji (a single emoji) and `label` replaces the descriptive text (up to 60 characters). A badge is assigned automatically at startup, so call this only when the automatic emoji collides with another running session or the folder name does not describe the work.",
		approval: "read",
		parameters: z.object({
			emoji: z.string().optional(),
			label: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (typeof params.emoji === "string" && params.emoji.trim().length > 0) {
				badgeEmoji = [...params.emoji.trim()].slice(0, 2).join("");
			}
			if (typeof params.label === "string") badgeOverride = params.label.trim().slice(0, 60);
			writeSessionRecord(ctx);
			detach(renameTopicIfStale(ctx), "topic rename");
			return { content: [{ type: "text", text: `Badge is now: ${badge(ctx)}` }], details: { badge: badge(ctx) } };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		if (config === null && existsSync(CONFIG_PATH)) {
			// The file exists but did not parse, which is what a write race looks like. One retry.
			await new Promise((resolve) => setTimeout(resolve, 300));
			config = loadConfig();
		}
		if (config === null) {
			pi.logger.debug("notify-telegram disabled: no usable config at ~/.omp/agent/notify-telegram.json");
			return;
		}
		sessionId = ctx.sessionManager.getSessionId();
		mkdirSync(SESSIONS_DIR, { recursive: true });
		mkdirSync(join(INBOX_DIR, sessionId), { recursive: true });
		reapDeadSessions();
		sessionTag = claimTag();
		badgeEmoji = claimBadge();
		const previous = readSessionRecord(sessionId);
		badgeOverride = previous?.label ?? "";
		if (previous?.standing != null && typeof previous.standing.id === "string") {
			standingQuestion = previous.standing;
		}
		if (Array.isArray(previous?.recent)) {
			recentMessages.push(...previous.recent.filter((n): n is number => typeof n === "number"));
		}
		lastNotifiedAt = typeof previous?.lastNotified === "number" ? previous.lastNotified : 0;
		if (existsSync(LOCK_FILE) && statSync(LOCK_FILE).isDirectory()) {
			rmSync(LOCK_FILE, { recursive: true, force: true });
		}
		rmSync(LEGACY_LOCK_DIR, { recursive: true, force: true });
		writeSessionRecord(ctx);
		acquireLock();

		if (ctx.hasUI) {
			unsubscribeInput = ctx.ui.onTerminalInput(() => {
				lastLocalInput = Date.now();
			});
		}

		// Timers before any network call: a failed start must still receive.
		ctx.setInterval(() => {
			try {
				writeSessionRecord(ctx);
				detach(renameTopicIfStale(ctx), "topic rename");
				if (ownsLock()) refreshLock();
				else acquireLock();
			} catch (error) {
				pi.logger.warn("notify-telegram: heartbeat failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, HEARTBEAT_MS);

		ctx.setInterval(() => {
			try {
				detach(drainInbox(), "inbox drain");
				// Re-read rather than trusting a boolean: two pollers caused 918 Telegram conflicts.
				if (ownsLock()) detach(pollOnce(), "telegram poll");
			} catch (error) {
				pi.logger.warn("notify-telegram: drain failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, DRAIN_MS);

		try {
			await sweepPendingTopics();
			await ensureTopic(ctx);
			writeSessionRecord(ctx);
		} catch (error) {
			pi.logger.warn("notify-telegram: topic setup failed, continuing without a topic", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.on("input", async (_event, ctx) => {
		turnSummary = null;
		statusBlockUsed = false;
		const standing = standingQuestion;
		if (standing !== null) {
			standingQuestion = null;
			writeSessionRecord(ctx);
			detach(closeAskMessage(standing.messageId, "Answered at the terminal."), "standing-question close");
		}
	});

	pi.on("session_stop", async (_event, ctx) => {
		if (config === null || !config.notifyOnTurnEnd) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		const where = tmuxLocation();
		const suffix = where === null ? "" : ` (tmux ${where})`;

		if (turnSummary !== null) {
			const heads = {
				green: "\u{1F7E2} Turn finished",
				orange: "\u{1F7E0} Reply wanted",
				red: "\u{1F534} Action required",
			};
			const recorded = turnSummary;
			turnSummary = null;
			if (recorded.options === undefined) {
				detach(notify(ctx, `${heads[recorded.urgency]}${suffix}`, recorded.text), "turn-end notice");
				return;
			}
			detach(sendStandingQuestion(ctx, heads[recorded.urgency] + suffix, recorded), "turn-end question");
			return;
		}

		if (!statusBlockUsed) {
			statusBlockUsed = true;
			return {
				decision: "block" as const,
				reason:
					"Before finishing, call notify_status with a one-or-two-sentence summary of where things stand and an urgency (green done, orange reply wanted, red blocked). Be proactive about next steps: name the concrete ones when they exist, and say plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. If any user action is wanted, such as continue, review, or a decision, also set question and 2 to 6 short options drawn from those real next steps, which become tappable buttons whose label starts the next turn. Omit them when there is genuinely nothing to ask. The user is away from the terminal and sees only this.",
			};
		}

		const tail = lastAssistantTail(ctx);
		const wantsReply = /\?\s*$/m.test(tail);
		const title = `${wantsReply ? "\u{1F7E0} Reply wanted" : "\u{1F7E2} Turn finished"}${suffix}`;
		detach(notify(ctx, title, tail.length > 0 ? tail : "Awaiting your next instruction."), "turn-end notice");
	});

	pi.on("tool_approval_requested", async (event, ctx) => {
		if (config === null) return;
		const named = event !== null && typeof event === "object" && "toolName" in event ? event.toolName : undefined;
		const tool = typeof named === "string" ? named : "a tool";
		const where = tmuxLocation();
		detach(
			notify(
				ctx,
				`\u{1F534} Approval needed${where === null ? "" : ` (tmux ${where})`}`,
				`${tool} is waiting for approval.`,
			),
			"approval notice",
		);
	});

	pi.on("credential_disabled", async (_event, ctx) => {
		if (config === null) return;
		detach(notify(ctx, "\u{1F534} Credential problem", "A provider credential was disabled."), "credential notice");
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = null;
		if (config !== null && topicId !== null) {
			writeFileAtomic(PENDING_TOPICS, JSON.stringify([...readPendingTopics(), topicId]));
			detach(
				callTelegram(config, "deleteForumTopic", { chat_id: config.chatId, message_thread_id: topicId }, 5_000),
				"topic delete",
			);
			unlinkSync(join(SESSIONS_DIR, `${sessionId}.json`));
		}
		releaseLock();
	});
}
