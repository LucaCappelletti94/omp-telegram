import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const CONFIG_PATH = join(AGENT_DIR, "notify-telegram.json");
const STATE_DIR = join(AGENT_DIR, "notify-telegram");
const LOCK_FILE = join(STATE_DIR, "poller.lock");
const LEGACY_LOCK_DIR = join(STATE_DIR, "poller.lock.d");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const PENDING_TOPICS_DIR = join(STATE_DIR, "pending-topics");
const INBOX_DIR = join(STATE_DIR, "inbox");
const MEDIA_DIR = join(STATE_DIR, "media");

const HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 45_000;
const DRAIN_MS = 1_000;
const LONG_POLL_S = 25;
const BUTTON_TEXT_MAX = 60;
const PREVIEW_MAX = 300;
const RECENT_MESSAGE_CAP = 60;
const TELEGRAM_TEXT_MAX = 4096;
const TELEGRAM_CAPTION_MAX = 1024;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_KEEP_MS = 7 * 24 * 3600 * 1000;
const TYPING_MS = 5_000;
const DRAFT_MS = 1_500;
/** The party-popper send effect, verified against the live API; effects exist in private chats only. */
const GREEN_EFFECT_ID = "5046509860389126442";

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
	streamDrafts: boolean;
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
	standing: StandingQuestion | null;
	/** Message carrying a live close-session button on a plain green summary. */
	closeOffer: number | null;
	/** Message pinned for a red status; unpinned when the next turn starts. */
	pinned: number | null;
	/** Draft-stream identifier; a stop press routes back through it. */
	draftId: number;
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
	photo?: Array<{ file_id: string; file_size?: number }>;
	voice?: { file_id: string; file_size?: number; mime_type?: string };
	audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
	document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
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
	stopped_message_generation?: { chat: { id: number }; message_thread_id?: number; draft_id: number };
}

interface InlineButton {
	text: string;
	callback_data: string;
	style?: "danger" | "success" | "primary";
	disabled?: Record<string, never>;
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
	settlementHeads: string[];
	index: number;
	messageId: number | null;
	selected: Set<string>[];
	custom: Array<string | undefined>;
	awaitingText: boolean;
	finish: (results: AskResult[]) => void;
}

interface ApprovalNotice {
	toolCallId: string;
	toolName: string;
	messageId: number | null;
	resolution: { approved: boolean; reason: string } | null;
}

interface TurnStatus {
	text: string;
	urgency: "green" | "orange" | "red";
	question?: string;
	options?: string[];
}

interface StandingQuestion {
	id: string;
	messageId: number | null;
	labels: string[];
	head: string;
}

interface ModelUsage {
	input: number;
	output: number;
	cost: number;
}

interface InboxEntry {
	kind: "text" | "callback" | "file" | "command";
	/** Text, callback payload, downloaded file path, or command name. */
	value: string;
	/** Incoming Telegram message id, for delivery receipts. */
	messageId?: number;
	/** Message id the sender replied to. */
	replyTo?: number;
	caption?: string;
	mime?: string;
}

interface IncomingFile {
	fileId: string;
	mime: string;
	size?: number;
	name?: string;
}

/** Largest photo size wins; Telegram photos are always JPEG. */
function pickMedia(message: TelegramMessage): IncomingFile | null {
	const photo = message.photo?.at(-1);
	if (photo !== undefined) return { fileId: photo.file_id, mime: "image/jpeg", size: photo.file_size };
	const voice = message.voice;
	if (voice !== undefined)
		return { fileId: voice.file_id, mime: voice.mime_type ?? "audio/ogg", size: voice.file_size };
	const audio = message.audio;
	if (audio !== undefined) {
		return {
			fileId: audio.file_id,
			mime: audio.mime_type ?? "audio/mpeg",
			size: audio.file_size,
			name: audio.file_name,
		};
	}
	const document = message.document;
	if (document !== undefined) {
		return {
			fileId: document.file_id,
			mime: document.mime_type ?? "application/octet-stream",
			size: document.file_size,
			name: document.file_name,
		};
	}
	return null;
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
	if (typeof raw.token !== "string" || !/^\d+:[A-Za-z0-9_-]{25,}$/u.test(raw.token)) return null;
	if (typeof raw.chatId !== "number") return null;
	return {
		token: raw.token,
		chatId: raw.chatId,
		offset: typeof raw.offset === "number" ? raw.offset : 0,
		quietSeconds: typeof raw.quietSeconds === "number" ? raw.quietSeconds : 45,
		notifyOnTurnEnd: raw.notifyOnTurnEnd !== false,
		streamDrafts: raw.streamDrafts !== false,
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
	const record = parsed as Record<string, unknown>;
	// A stale poller must never rewind an offset another process already advanced past.
	if (typeof record.offset === "number" && record.offset >= offset) return;
	const next = { ...record, offset };
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

	// NUL is the stash marker below; hostile input must not be able to forge or collide with it.
	let work = source
		.replaceAll("\u0000", "")
		.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
			const opener = language.length > 0 ? `<pre><code class="language-${language}">` : "<pre>";
			const closer = language.length > 0 ? "</code></pre>" : "</pre>";
			return stash(`${opener}${escapeHtml(code.replace(/\n$/, ""))}${closer}`);
		});
	work = work.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

	work = escapeHtml(work);
	// Headings have no Telegram equivalent and otherwise render as literal hash marks.
	work = work.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	work = work.replace(
		/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
		(_match, label: string, url: string) => `<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`,
	);
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

/** Best-effort question texts from a half-streamed ask tool-call JSON, tolerant of a cut mid-string. */
function extractQuestionPreviews(partialJson: string): string[] {
	const previews: string[] = [];
	const opener = /(?<!\\)"question"\s*:\s*"/g;
	let match = opener.exec(partialJson);
	while (match !== null) {
		let i = opener.lastIndex;
		let out = "";
		let closed = false;
		while (i < partialJson.length && !closed) {
			const ch = partialJson[i] ?? "";
			if (ch === '"') {
				closed = true;
			} else if (ch === "\\") {
				const esc = partialJson[i + 1];
				if (esc === undefined) break;
				if (esc === "u") {
					const hex = partialJson.slice(i + 2, i + 6);
					if (!/^[0-9a-fA-F]{4}$/u.test(hex)) break;
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 6;
				} else {
					out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
					i += 2;
				}
			} else {
				out += ch;
				i += 1;
			}
		}
		if (out.trim().length > 0) previews.push(out);
		match = opener.exec(partialJson);
	}
	return previews;
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

/** The options stay visible but dead, with the chosen answers ticked. */
function settledKeyboard(labels: string[], chosen: Set<string>): InlineButton[][] {
	return packRows(
		labels.map((label) => ({
			text: `${chosen.has(label) ? "\u2713 " : ""}${label}`.slice(0, BUTTON_TEXT_MAX),
			callback_data: "x",
		})),
	);
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
	let standingQuestion: StandingQuestion | null = null;
	let closeOfferMessageId: number | null = null;
	let statusBlockUsed = false;
	let badgeEmoji = "";
	let badgeOverride = "";
	let topicId: number | null = null;
	let topicName = "";
	const recentMessages: number[] = [];
	let lastNotifiedAt = 0;
	let turnActive = false;
	let typingSentAt = 0;
	let approvalWaiting = false;
	let approvalNotice: ApprovalNotice | null = null;
	let pinnedMessageId: number | null = null;
	let topicIcons: Array<{ emoji?: string; custom_emoji_id?: string }> | null = null;
	/** The live session context, for record writes outside event handlers. */
	let sessionCtx: ExtensionContext | null = null;
	let draftId = 0;
	let draftText = "";
	let draftDirty = false;
	let draftSentAt = 0;
	let currentTool = "";
	let askStream: { index: number; buffer: string } | null = null;
	let askPreview = "";
	let turnStartingModel = "unavailable";
	let turnTools = 0;
	const turnUsageByModel = new Map<string, ModelUsage>();
	const noticedKinds = new Set<string>();
	let activeCompaction: { trigger: string; action: string } | null = null;

	/** A rejected detached promise is fatal in omp; the token never reaches the log. */
	function detach(work: Promise<unknown>, label: string): void {
		work.catch((error) => {
			const raw = error instanceof Error ? error.message : String(error);
			pi.logger.warn(`notify-telegram: ${label} failed`, {
				error: config === null ? raw : raw.split(config.token).join("<token>"),
			});
		});
	}

	function callTelegram<T>(
		cfg: Config,
		method: string,
		body: Record<string, unknown>,
		timeoutMs: number,
	): Promise<T | null> {
		return callTelegramRaw<T>(cfg, method, body, timeoutMs, (failure) =>
			pi.logger.warn("telegram call failed", { ...failure }),
		);
	}

	function trackSent(sent: TelegramMessage | null): void {
		if (typeof sent?.message_id !== "number") return;
		recentMessages.push(sent.message_id);
		if (recentMessages.length > RECENT_MESSAGE_CAP) {
			recentMessages.splice(0, recentMessages.length - RECENT_MESSAGE_CAP);
		}
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
		// A raw slice can end on the high half of a surrogate pair, which is invalid JSON.
		const last = source.charCodeAt(source.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) source = source.slice(0, -1);
		let sent = await callTelegram<TelegramMessage>(
			cfg,
			method,
			{ ...quiet, ...body, text: toTelegramHtml(source), parse_mode: "HTML" },
			15_000,
		);
		if (sent === null) {
			pi.logger.warn("telegram: rich send rejected, retrying as plain text", { method });
			const { message_effect_id: _effect, ...safe } = body;
			sent = await callTelegram<TelegramMessage>(cfg, method, { ...quiet, ...safe, text: source }, 15_000);
		}
		if (method === "sendMessage") trackSent(sent);
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
			closeOffer: closeOfferMessageId,
			pinned: pinnedMessageId,
			draftId,
			heartbeat: Date.now(),
		};
		writeFileAtomic(join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(record), 0o600);
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
		for (let attempt = 0; attempt < 128; attempt++) {
			const candidate = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
			if (!taken.has(candidate)) return candidate;
		}
		// Beyond 128 collisions the roster is effectively full; a clash is astronomically unlikely.
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

	let lastMediaReap = 0;

	/** Downloaded Telegram files are working input, not an archive. */
	function reapOldMedia(): void {
		if (Date.now() - lastMediaReap < 3_600_000) return;
		lastMediaReap = Date.now();
		if (!existsSync(MEDIA_DIR)) return;
		for (const entry of readdirSync(MEDIA_DIR)) {
			const path = join(MEDIA_DIR, entry);
			try {
				if (Date.now() - statSync(path).mtimeMs > MEDIA_KEEP_MS) unlinkSync(path);
			} catch {}
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
	function taskName(ctx: ExtensionContext): string {
		const named = badgeOverride.length > 0 ? badgeOverride : (ctx.sessionManager.getSessionName() ?? "");
		if (named.length > 0) return named.slice(0, 60);
		const folder =
			ctx.cwd
				.split("/")
				.filter((part) => part.length > 0)
				.pop() ?? ctx.cwd;
		return `${folder} [${sessionTag}]`;
	}

	function threaded(extra: Record<string, unknown>): Record<string, unknown> {
		if (config === null) return extra;
		const base = { chat_id: config.chatId, ...extra };
		return topicId === null ? base : { ...base, message_thread_id: topicId };
	}

	/** Re-read per message because tmux windows can move. */
	function tmuxLocation(): string | null {
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return null;
		try {
			const out = execFileSync(
				"tmux",
				["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"],
				{ timeout: 2000 },
			)
				.toString()
				.trim();
			return out.length > 0 ? out : null;
		} catch {
			return null;
		}
	}

	/** Puts this session's window in front for the user's return, but never while they are typing elsewhere. */
	function focusTmuxWindow(): void {
		if (config === null || Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return;
		try {
			execFileSync("tmux", ["select-window", "-t", pane], { timeout: 2000 });
		} catch {}
	}

	/** Offered on green summaries: everything is done, so the session may be shut down from the phone. */
	function closeSessionButton(): InlineButton {
		const label = process.env.TMUX === undefined ? "Close this session" : "Close this session and its tmux tab";
		return { text: label, callback_data: `k:${sessionTag}`, style: "danger" };
	}

	/** A detached shell outlives omp, so the window dies only after the process has exited. */
	function scheduleTmuxWindowKill(): void {
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return;
		let windowId = "";
		try {
			windowId = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{window_id}"], { timeout: 2000 })
				.toString()
				.trim();
		} catch {
			return;
		}
		if (!/^@\d+$/u.test(windowId)) return;
		try {
			spawn("sh", ["-c", `sleep 2; exec tmux kill-window -t '${windowId}'`], {
				detached: true,
				stdio: "ignore",
			}).unref();
		} catch {}
	}

	/** The green-summary close button: strip the button, then let the ordinary shutdown path run. */
	async function closeSessionFromTelegram(messageId: number | undefined): Promise<void> {
		if (messageId !== undefined && closeOfferMessageId === messageId) closeOfferMessageId = null;
		if (config !== null && typeof messageId === "number" && standingQuestion?.messageId !== messageId) {
			// A standing question is rewritten by session_shutdown; a plain summary only loses its button.
			await callTelegram(
				config,
				"editMessageReplyMarkup",
				{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
				10_000,
			);
		}
		scheduleTmuxWindowKill();
		sessionCtx?.shutdown();
	}

	/** The close offer dies the moment new work starts; a stale destructive button invites accidents. */
	function retireCloseOffer(withEdit: boolean): void {
		const messageId = closeOfferMessageId;
		if (messageId === null) return;
		closeOfferMessageId = null;
		if (sessionCtx !== null) writeSessionRecord(sessionCtx);
		if (!withEdit || config === null) return;
		detach(
			callTelegram(
				config,
				"editMessageReplyMarkup",
				{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
				10_000,
			),
			"close-offer retire",
		);
	}

	/** One line per omp window, read from the same pane titles that drive the tmux tabs. */
	function fleetReport(): string | null {
		if (process.env.TMUX === undefined) return null;
		let out: string;
		try {
			out = execFileSync(
				"tmux",
				["list-windows", "-a", "-F", "#{session_name}\t#{window_index}\t#{window_bell_flag}\t#{pane_title}"],
				{ timeout: 2000 },
			).toString();
		} catch {
			return null;
		}
		const rows: { session: string; index: string; state: keyof typeof counts; label: string }[] = [];
		const counts = { working: 0, waiting: 0, finished: 0, idle: 0 };
		for (const raw of out.split("\n")) {
			const parts = raw.split("\t");
			if (parts.length < 4) continue;
			const title = parts.slice(3).join("\t");
			if (!title.startsWith("\u03C0 ")) continue;
			const sep = title.codePointAt(2) ?? 0;
			const state =
				sep === 0x21 ? "waiting" : sep >= 0x2800 && sep <= 0x28ff ? "working" : parts[2] === "1" ? "finished" : "idle";
			counts[state] += 1;
			rows.push({ session: parts[0] ?? "", index: parts[1] ?? "", state, label: title.slice(4) });
		}
		if (rows.length === 0) return "\u{1F535} No omp windows in tmux right now.";
		const manySessions = new Set(rows.map((row) => row.session)).size > 1;
		const summary = (
			[
				[counts.working, "working"],
				[counts.waiting, "waiting for you"],
				[counts.finished, "finished"],
				[counts.idle, "idle"],
			] as const
		)
			.filter(([count]) => count > 0)
			.map(([count, word]) => `${count} ${word}`)
			.join(", ");
		const glyphs = { working: "\u{1F7E2}", waiting: "\u{1F534}", finished: "\u2705", idle: "\u26AA" };
		const lines = rows.map(
			(row) => `${glyphs[row.state]} ${manySessions ? `${row.session}:` : ""}${row.index} ${row.label}`,
		);
		return `\u{1F39B} ${summary}\n${lines.join("\n")}`;
	}

	function sessionContextLine(ctx: ExtensionContext): string {
		const model = ctx.model === undefined ? "unavailable" : `${ctx.model.provider}/${ctx.model.id}`;
		return `Task: ${taskName(ctx)} | Model: ${model} | Tmux: ${tmuxLocation() ?? "not attached"}`;
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

	async function sessionNotice(ctx: ExtensionContext, text: string): Promise<void> {
		await serviceNotice(`${sessionContextLine(ctx)}\n\n${text}`);
	}

	/** Structured markdown (tables, fences) goes out as a native rich message; anything else keeps the HTML subset path. */
	async function sendStructured(
		cfg: Config,
		body: Record<string, unknown>,
		plain: string,
	): Promise<TelegramMessage | null> {
		if (/```|(^|\n)\|.+\|/.test(plain)) {
			const sent = await callTelegram<TelegramMessage>(
				cfg,
				"sendRichMessage",
				{ ...body, rich_message: { markdown: plain } },
				15_000,
			);
			if (sent !== null) {
				trackSent(sent);
				return sent;
			}
		}
		return await sendOrEdit(cfg, "sendMessage", body, plain);
	}

	async function notify(
		ctx: ExtensionContext,
		title: string,
		body: string,
		extra: Record<string, unknown> = {},
	): Promise<TelegramMessage | null> {
		if (config === null) return null;
		const sent = await sendStructured(config, threaded(extra), withHead(ctx, title, body));
		lastNotifiedAt = Date.now();
		writeSessionRecord(ctx);
		return sent;
	}

	function finishApprovalNotice(ctx: ExtensionContext, notice: ApprovalNotice): void {
		if (approvalNotice !== notice || notice.messageId === null || notice.resolution === null || config === null) return;
		approvalNotice = null;
		const { approved, reason } = notice.resolution;
		const title = approved ? "Approval granted" : "Approval denied";
		const detail = reason.length > 0 ? `\nReason: ${reason}` : "";
		detach(
			sendOrEdit(
				config,
				"editMessageText",
				{ chat_id: config.chatId, message_id: notice.messageId },
				withHead(ctx, title, `${notice.toolName} was ${approved ? "approved" : "denied"}.${detail}`),
			),
			"approval resolution",
		);
	}

	/** The typing status lasts about five seconds; refresh while the agent loop runs and nothing waits on the user. */
	function maybeType(): void {
		if (config === null || !turnActive || pendingAsk !== null || approvalWaiting) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		if (Date.now() - draftSentAt < 10_000) return;
		if (Date.now() - typingSentAt < TYPING_MS) return;
		typingSentAt = Date.now();
		detach(callTelegram(config, "sendChatAction", threaded({ action: "typing" }), 10_000), "typing action");
	}

	/** Streams the turn as an ephemeral draft bubble with a native stop control. */
	function maybeDraft(): void {
		if (config === null || !config.streamDrafts || config.chatId <= 0 || sessionCtx === null) return;
		if (!turnActive || pendingAsk !== null || approvalWaiting) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		if (!draftDirty || Date.now() - draftSentAt < DRAFT_MS) return;
		draftDirty = false;
		draftSentAt = Date.now();
		const context = sessionContextLine(sessionCtx);
		const tool = currentTool.length > 0 ? `\u25B8 ${currentTool}` : "";
		const prefix = `${context}\n\n`;
		const suffix = tool.length > 0 ? `\n\n${tool}` : "";
		const tailLimit = Math.max(0, TELEGRAM_TEXT_MAX - prefix.length - suffix.length);
		const previewing = askPreview.length > 0;
		const source = previewing ? askPreview : draftText;
		let tail =
			tailLimit === 0 || source.length <= tailLimit
				? source.slice(0, tailLimit)
				: previewing
					? source.slice(0, tailLimit)
					: source.slice(-tailLimit);
		if (previewing) {
			const last = tail.charCodeAt(tail.length - 1);
			if (last >= 0xd800 && last <= 0xdbff) tail = tail.slice(0, -1);
		} else {
			const lead = tail.charCodeAt(0);
			if (lead >= 0xdc00 && lead <= 0xdfff) tail = tail.slice(1);
		}
		const text = tail.length > 0 ? `${prefix}${tail}${suffix}` : `${context}${suffix}`;
		const cfg = config;
		const body = threaded({ draft_id: draftId, can_stop: true });
		detach(
			(async () => {
				// Unclosed constructs degrade to literal text in toTelegramHtml, so a rendered draft is safe
				// mid-stream; a rejected call still falls back to the raw text rather than dropping the tick.
				const sent = await callTelegram(
					cfg,
					"sendMessageDraft",
					{ ...body, text: toTelegramHtml(text), parse_mode: "HTML" },
					10_000,
				);
				if (sent === null) await callTelegram(cfg, "sendMessageDraft", { ...body, text }, 10_000);
			})(),
			"draft stream",
		);
	}

	/** One notice per kind per turn keeps recovery details concise. */
	function transparencyNotice(kind: string, text: string, ctx?: ExtensionContext): void {
		if (config === null || noticedKinds.has(kind)) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		noticedKinds.add(kind);
		detach(ctx === undefined ? serviceNotice(text) : sessionNotice(ctx, text), "transparency notice");
	}

	/** Usage lines stay grouped by model. */
	function usageFooter(): string {
		const lines: string[] = [];
		for (const [model, usage] of turnUsageByModel) {
			const parts = [model];
			if (usage.input + usage.output > 0) {
				const [inTokens, outTokens] = [usage.input, usage.output].map((value) =>
					value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value),
				);
				parts.push(`${inTokens} in / ${outTokens} out`);
			}
			if (usage.cost > 0) parts.push(`$${usage.cost >= 0.095 ? usage.cost.toFixed(2) : usage.cost.toFixed(3)}`);
			lines.push(`\`${parts.join(" \u00B7 ")}\``);
		}
		if (turnTools > 0) lines.push(`\`${turnTools} ${turnTools === 1 ? "tool" : "tools"}\``);
		return lines.length === 0 ? "" : `\n\n${lines.join("\n")}`;
	}

	/** A thumbs-up on the delivered message: received, the turn is running. */
	function ackDelivered(messageId: number | undefined): void {
		if (config === null || typeof messageId !== "number") return;
		detach(
			callTelegram(
				config,
				"setMessageReaction",
				{ chat_id: config.chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "\u{1F44D}" }] },
				10_000,
			),
			"delivery receipt",
		);
	}

	/** Green gets the celebration effect; red gets pinned by the caller. */
	function urgencyExtras(urgency: TurnStatus["urgency"]): Record<string, unknown> {
		if (urgency !== "green" || config === null || config.chatId <= 0) return {};
		return { message_effect_id: GREEN_EFFECT_ID };
	}

	/** A red status stays pinned until the next turn touches the session. */
	async function pinRed(ctx: ExtensionContext, sent: TelegramMessage | null): Promise<void> {
		if (config === null || typeof sent?.message_id !== "number") return;
		unpinRed(ctx);
		await callTelegram(
			config,
			"pinChatMessage",
			{ chat_id: config.chatId, message_id: sent.message_id, disable_notification: true },
			10_000,
		);
		pinnedMessageId = sent.message_id;
		writeSessionRecord(ctx);
	}

	function unpinRed(ctx: ExtensionContext): void {
		if (config === null || pinnedMessageId === null) return;
		const messageId = pinnedMessageId;
		pinnedMessageId = null;
		writeSessionRecord(ctx);
		detach(
			callTelegram(config, "unpinChatMessage", { chat_id: config.chatId, message_id: messageId }, 10_000),
			"unpin",
		);
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
		if (topicIcons === null) {
			const stickers = await callTelegram<Array<{ emoji?: string; custom_emoji_id?: string }>>(
				config,
				"getForumTopicIconStickers",
				{},
				15_000,
			);
			topicIcons = Array.isArray(stickers) ? stickers : [];
		}
		const icon = topicIcons.find((sticker) => sticker.emoji === badgeEmoji)?.custom_emoji_id;
		const created = await callTelegram<unknown>(
			config,
			"createForumTopic",
			{
				chat_id: config.chatId,
				name,
				icon_color: colours[index],
				...(typeof icon === "string" ? { icon_custom_emoji_id: icon } : {}),
			},
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

	function readPendingTopics(): { path: string; topicId: number }[] {
		if (!existsSync(PENDING_TOPICS_DIR)) return [];
		const pending: { path: string; topicId: number }[] = [];
		for (const entry of readdirSync(PENDING_TOPICS_DIR)) {
			const path = join(PENDING_TOPICS_DIR, entry);
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (typeof parsed === "number") pending.push({ path, topicId: parsed });
				else unlinkSync(path);
			} catch {
				// An unreadable entry would otherwise wedge the sweep forever.
				try {
					unlinkSync(path);
				} catch {}
			}
		}
		return pending;
	}

	/** Shutdown cannot await; the next start sweeps the queue. Unlink first claims the entry across processes. */
	async function sweepPendingTopics(): Promise<void> {
		if (config === null) return;
		for (const { path, topicId } of readPendingTopics()) {
			try {
				unlinkSync(path);
			} catch {
				continue;
			}
			await callTelegram(config, "deleteForumTopic", { chat_id: config.chatId, message_thread_id: topicId }, 15_000);
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
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileAtomic(join(dir, `${updateId}.json`), JSON.stringify(entry), 0o600);
	}

	/** Bot API refuses getFile beyond 20 MB; larger uploads get a notice instead of silence. */
	async function downloadMedia(cfg: Config, media: IncomingFile, updateId: number): Promise<string | null> {
		if (media.size !== undefined && media.size > MEDIA_MAX_BYTES) return null;
		const file = await callTelegram<{ file_path?: string }>(cfg, "getFile", { file_id: media.fileId }, 30_000);
		const remote = file?.file_path;
		if (typeof remote !== "string" || remote.length === 0) return null;
		// A thrown fetch here must not escape: pollOnce would never advance the update
		// offset, refetching the batch and re-delivering its earlier updates forever.
		let bytes: Uint8Array;
		try {
			const response = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${remote}`, {
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) return null;
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch {
			return null;
		}
		if (bytes.byteLength > MEDIA_MAX_BYTES) return null;
		const base = (media.name ?? remote).split("/").at(-1) ?? "file";
		const safe = base.replaceAll(/[^\w.-]/gu, "_").slice(-80);
		mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
		const path = join(MEDIA_DIR, `${updateId}-${safe}`);
		writeFileSync(path, bytes, { mode: 0o600 });
		return path;
	}

	async function handleUpdate(cfg: Config, update: TelegramUpdate): Promise<void> {
		const stopped = update.stopped_message_generation;
		if (stopped !== undefined) {
			if (stopped.chat.id === cfg.chatId) {
				const owner = allRecords().find(
					({ record }) => record.draftId === stopped.draft_id && Date.now() - record.heartbeat <= LOCK_STALE_MS,
				)?.id;
				if (owner !== undefined) deliver(owner, update.update_id, { kind: "command", value: "stopturn" });
			}
			return;
		}
		const callback = update.callback_query;
		if (callback !== undefined && callback.data !== undefined) {
			if (callback.message?.chat.id !== cfg.chatId || callback.from?.id !== cfg.chatId) {
				pi.logger.warn("telegram: rejected a button press from an unexpected origin", {
					chat: callback.message?.chat.id,
					from: callback.from?.id,
				});
				return;
			}
			const owner = routeByAskId(callback.data.split(":")[1] ?? "");
			await callTelegram(
				cfg,
				"answerCallbackQuery",
				{
					callback_query_id: callback.id,
					text:
						owner === null
							? "That question's session is gone."
							: callback.data.startsWith("k:")
								? "Closing the session."
								: callback.data.startsWith("c:")
									? "Starting the next turn."
									: "Answer recorded.",
				},
				10_000,
			);
			if (owner !== null)
				deliver(owner, update.update_id, {
					kind: "callback",
					value: callback.data,
					messageId: callback.message?.message_id,
				});
			return;
		}

		const message = update.message;
		if (message === undefined) return;
		if (message.chat.id !== cfg.chatId) {
			pi.logger.warn("telegram: rejected a message from an unexpected chat", { chat: message.chat.id });
			return;
		}
		const thread = message.message_thread_id;
		const replyTo = message.reply_to_message?.message_id;
		const text = message.text ?? message.caption;

		const command = typeof text === "string" ? /^\/(hidequestions|status|fleet)\b/u.exec(text.trim())?.[1] : undefined;
		if (command === "fleet") {
			const report = fleetReport();
			await callTelegram(
				cfg,
				"sendMessage",
				{
					chat_id: cfg.chatId,
					...(thread === undefined ? {} : { message_thread_id: thread }),
					text: report ?? "\u{1F535} No tmux server is reachable from this process.",
				},
				15_000,
			);
			return;
		}
		if (command !== undefined) {
			const scoped = thread === undefined ? null : routeMessage(thread, replyTo);
			const targets =
				scoped !== null
					? [scoped]
					: allRecords()
							.filter(({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS)
							.map(({ id }) => id);
			for (const target of targets) {
				deliver(target, update.update_id, { kind: "command", value: command });
			}
			return;
		}

		const media = pickMedia(message);
		if (media !== null) {
			const target = routeMessage(thread, replyTo);
			if (target === null) {
				await serviceNotice("No live omp session owns that message, so it was dropped.", thread);
				return;
			}
			const saved = await downloadMedia(cfg, media, update.update_id);
			if (saved === null) {
				await serviceNotice("That file could not be fetched (20 MB is the ceiling), so it was dropped.", thread);
				return;
			}
			deliver(target, update.update_id, {
				kind: "file",
				value: saved,
				mime: media.mime,
				caption: message.caption,
				messageId: message.message_id,
				replyTo,
			});
			return;
		}

		if (text === undefined || text.length === 0) {
			await serviceNotice(
				"That message type does not reach the agent. Send text, a photo, a voice note, an audio file, or a document.",
				thread,
			);
			return;
		}

		const target = routeMessage(thread, replyTo);
		if (target === null) {
			await serviceNotice(
				"No live omp session owns that message, so it was dropped. Reply to a message from the session you mean.",
				thread,
			);
			return;
		}
		deliver(target, update.update_id, {
			kind: "text",
			value: text,
			messageId: message.message_id,
			replyTo,
		});
	}

	async function pollOnce(): Promise<void> {
		if (config === null || pollInFlight) return;
		pollInFlight = true;
		try {
			const updates = await callTelegram<TelegramUpdate[]>(
				config,
				"getUpdates",
				{
					offset: config.offset,
					timeout: LONG_POLL_S,
					allowed_updates: ["message", "callback_query", "stopped_message_generation"],
				},
				(LONG_POLL_S + 10) * 1000,
			);
			if (updates === null || updates.length === 0) return;
			// The long poll can outlive a lock steal; the batch then belongs to the new holder.
			if (!ownsLock()) return;
			let highest = config.offset - 1;
			for (const update of updates) {
				highest = Math.max(highest, update.update_id);
				try {
					await handleUpdate(config, update);
				} catch (error) {
					// One malformed or failing update must not wedge the batch: the offset still advances.
					pi.logger.warn("notify-telegram: skipped a malformed update", {
						update: update.update_id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
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
		const markup = { inline_keyboard: questionKeyboard(ask, question), force_reply: true };

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

	/** Settled options survive as dead grey buttons. */
	async function settleQuestionMessage(
		messageId: number | null,
		head: string,
		result: string,
		keep?: InlineButton[][],
	): Promise<void> {
		if (config === null || messageId === null) return;
		const inline_keyboard =
			keep === undefined
				? []
				: keep.map((row) => row.map((button) => ({ ...button, callback_data: "x", disabled: {} })));
		await sendOrEdit(
			config,
			"editMessageText",
			{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard } },
			`${head}\n\n${result}`,
		);
	}

	/** Blocks nothing: a press starts the next turn. Only the latest stands. */
	async function sendStandingQuestion(ctx: ExtensionContext, title: string, recorded: TurnStatus): Promise<void> {
		if (config === null || recorded.options === undefined) return;
		const superseded = standingQuestion;
		standingSeq += 1;
		const id = `${sessionTag}-n${standingSeq.toString(36)}`;
		const prompt = recorded.question?.trim() || recorded.text;
		const settlementHead = `${sessionContextLine(ctx)}\n\n${prompt}`;
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
		if (recorded.urgency === "green") keyboard.push([closeSessionButton()]);
		const sent = await sendStructured(
			config,
			threaded({
				reply_markup: { inline_keyboard: keyboard, force_reply: true },
				...urgencyExtras(recorded.urgency),
			}),
			body,
		);
		standingQuestion = {
			id,
			messageId: sent?.message_id ?? null,
			labels: recorded.options,
			head: settlementHead,
		};
		lastNotifiedAt = Date.now();
		writeSessionRecord(ctx);
		if (recorded.urgency === "red") await pinRed(ctx, sent);
		if (superseded !== null) {
			await settleQuestionMessage(superseded.messageId, superseded.head, "Superseded by a newer question.");
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
			const head = ask.settlementHeads[ask.index];
			if (head !== undefined) {
				const labels = answered.options.map((option) => option.label);
				await settleQuestionMessage(
					ask.messageId,
					head,
					`**Answered:** ${shown}`,
					settledKeyboard(labels, new Set(chosen)),
				);
			}
		}
		if (pendingAsk !== ask) return; // Settled at the terminal while the closing edit was in flight.
		ask.messageId = null;
		ask.index += 1;
		if (ask.index >= ask.questions.length) {
			ask.finish(collectResults(ask));
			return;
		}
		await presentQuestion(ask, false);
		if (pendingAsk !== ask) {
			// The terminal settled this ask while the next question was in flight; close the orphan keyboard.
			const head = ask.settlementHeads[ask.index];
			if (head !== undefined) {
				await settleQuestionMessage(ask.messageId, head, "This question is no longer active.");
			}
			ask.messageId = null;
		}
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
				// A reply or an answer means attention is on this session: put its window in front for the return.
				if (entry.kind === "text" || (entry.kind === "callback" && !entry.value.startsWith("k:"))) {
					focusTmuxWindow();
				}

				const ask = pendingAsk;
				if (entry.kind === "command") {
					if (entry.value === "hidequestions") {
						if (ask !== null && ask.messageId !== null) {
							const head = ask.settlementHeads[ask.index];
							if (head !== undefined) {
								await settleQuestionMessage(ask.messageId, head, "Question hidden. It stays open at the terminal.");
							}
							ask.messageId = null;
						}
						const standing = standingQuestion;
						if (standing !== null) {
							standingQuestion = null;
							if (sessionCtx !== null) writeSessionRecord(sessionCtx);
							await settleQuestionMessage(standing.messageId, standing.head, "Question hidden.");
						}
						retireCloseOffer(true);
					}
					if (entry.value === "stopturn" && sessionCtx !== null && turnActive) {
						sessionCtx.abort();
						detach(sessionNotice(sessionCtx, "Stopping at your request."), "stop notice");
					}
					if (entry.value === "status" && sessionCtx !== null) {
						const state =
							pendingAsk !== null
								? "waiting on a question"
								: approvalWaiting
									? "waiting on a tool approval"
									: turnActive
										? currentTool.length > 0
											? `working (${currentTool})`
											: "working"
										: "idle";
						const lines = [
							`State: ${state}.`,
							standingQuestion !== null ? "A choice question stands open." : "",
							pinnedMessageId !== null ? "A red status is pinned." : "",
						].filter((line) => line.length > 0);
						await sessionNotice(sessionCtx, lines.join("\n"));
					}
					continue;
				}
				if (entry.kind === "callback" && entry.value.startsWith("k:")) {
					await closeSessionFromTelegram(entry.messageId);
					continue;
				}
				if (entry.kind === "callback" && entry.value.startsWith("c:")) {
					const [, choiceId, rawIndex] = entry.value.split(":");
					const standing = standingQuestion;
					if (standing !== null && standing.id === choiceId) {
						const label = standing.labels[Number.parseInt(rawIndex ?? "", 10)];
						standingQuestion = null;
						if (sessionCtx !== null) writeSessionRecord(sessionCtx);
						// Close even when the index is unreadable: state is already cleared,
						// and a live-looking keyboard on a dead question misleads.
						await settleQuestionMessage(
							standing.messageId,
							standing.head,
							label === undefined ? "This question is closed." : `**Chosen:** ${label}`,
							label === undefined ? undefined : settledKeyboard(standing.labels, new Set([label])),
						);
						if (label !== undefined) pi.sendUserMessage(label);
					} else if (sessionCtx !== null) {
						await sessionNotice(sessionCtx, "That question is closed. It was superseded or already answered.");
					} else {
						await serviceNotice("That question is closed. It was superseded or already answered.");
					}
					continue;
				}
				if (entry.kind === "callback") {
					if (ask !== null) await applyCallback(ask, entry.value);
					else if (sessionCtx !== null) {
						await sessionNotice(sessionCtx, "That question is closed. It was answered or cancelled at the terminal.");
					} else {
						await serviceNotice("That question is closed. It was answered or cancelled at the terminal.");
					}
					continue;
				}
				if (entry.kind === "file") {
					const caption = typeof entry.caption === "string" ? entry.caption.trim() : "";
					if (entry.mime?.startsWith("image/") === true) {
						let data = "";
						try {
							data = readFileSync(entry.value).toString("base64");
						} catch {}
						if (data.length === 0) {
							await serviceNotice("An image you sent could not be read back from disk, so it was not delivered.");
							continue;
						}
						pi.sendUserMessage(
							[
								{ type: "image", data, mimeType: entry.mime },
								{ type: "text", text: caption.length > 0 ? caption : "(image sent from Telegram)" },
							],
							{ deliverAs: "steer" },
						);
					} else {
						const tail = caption.length > 0 ? ` Caption: ${caption}` : "";
						pi.sendUserMessage(
							`The user sent a file from Telegram (${entry.mime ?? "unknown type"}), saved at ${entry.value}.${tail}`,
							{ deliverAs: "steer" },
						);
					}
					ackDelivered(entry.messageId);
					continue;
				}
				const isReplyToQuestion = ask !== null && typeof entry.replyTo === "number" && entry.replyTo === ask.messageId;
				if (ask !== null && (ask.awaitingText || isReplyToQuestion)) {
					ask.awaitingText = false;
					ask.custom[ask.index] = entry.value;
					ask.selected[ask.index] = new Set<string>();
					await advance(ask);
					continue;
				}
				pi.sendUserMessage(entry.value, { deliverAs: "steer" });
				ackDelivered(entry.messageId);
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
			const p = params as { questions: AskQuestion[]; context?: unknown };
			const questions = p.questions;
			const context = typeof p.context === "string" ? p.context.trim() : "";
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
			const settlementContext = sessionContextLine(ctx);
			const remote = Promise.withResolvers<AskResult[]>();
			const ask: PendingAsk = {
				askId: `${sessionTag}-${askSequence.toString(36)}`,
				head: badge(ctx),
				context,
				questions,
				settlementHeads: questions.map((question) => `${settlementContext}\n\n${question.question}`),
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
					const head = ask.settlementHeads[ask.index];
					if (head !== undefined) {
						detach(settleQuestionMessage(ask.messageId, head, "Answered at the terminal."), "terminal-answer edit");
					}
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
				const head = ask.settlementHeads[ask.index];
				if (head !== undefined) {
					await settleQuestionMessage(
						ask.messageId,
						head,
						aborted ? "Cancelled at the terminal." : "This question is no longer active.",
					);
				}
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
			"Record the turn-end Telegram notification, which is all the user sees when away from the terminal. Call it once, immediately before finishing a turn. `summary`: one or two plain sentences when no choice is attached, Markdown subset allowed. Be proactive about what comes next: name the concrete next steps when some exist, and state plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. When you believe the work is complete, weigh the follow-ups that fit what the turn was. After a bug fix, offer to hunt for surviving bugs of the same family, to complete the test coverage around the fix, and to run mutation testing to grade that coverage. After a feature, offer the related feature that naturally follows once this one is committed, a switch to a cleaner abstraction you found (a trait, generics, a blanket impl) before committing, a pass hunting for cleaner code, criterion benchmarks, or a strict review of the change as the repository's maintainer would run it. `urgency`: green when done and idle, orange when a reply is wanted, red when blocked on the user. Whenever any user action is wanted, also set `question` and 2 to 6 short `options` drawn from those real next steps. The notification must be answerable from a phone without terminal context. Options are bare labels, so the `summary` must name the decision, explain why it is needed now, and state what each option does or costs. Each option must name the action. Never use only a phase number or letter, such as `Start Phase 7`. The buttons start the next turn, and the most likely choice goes first. Omit `question` and `options` when there is genuinely nothing to ask, never pad with filler choices.",
		approval: "read",
		strict: true,
		parameters: z.object({
			summary: z.string(),
			urgency: z.string(),
			question: z.string().optional(),
			options: z.array(z.string()).optional(),
		}),
		async execute(_toolCallId, params) {
			const p = params as { summary?: unknown; urgency?: unknown; question?: unknown; options?: unknown };
			const summary = typeof p.summary === "string" ? p.summary.trim() : "";
			const raw = typeof p.urgency === "string" ? p.urgency.trim().toLowerCase() : "";
			const urgency = raw === "red" || raw === "orange" || raw === "green" ? raw : "green";
			if (summary.length === 0) {
				return { content: [{ type: "text", text: "Error: summary must not be empty" }], isError: true };
			}
			const labels = Array.isArray(p.options)
				? p.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
				: [];
			if (Array.isArray(p.options) && (labels.length < 2 || labels.length > 6)) {
				return { content: [{ type: "text", text: "Error: options must be 2 to 6 short labels" }], isError: true };
			}
			turnSummary = {
				text: summary.slice(0, 900),
				urgency,
				question: typeof p.question === "string" && p.question.trim().length > 0 ? p.question.trim() : undefined,
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
			const p = params as { emoji?: unknown; label?: unknown };
			if (typeof p.emoji === "string" && p.emoji.trim().length > 0) {
				badgeEmoji = [...p.emoji.trim()].slice(0, 2).join("");
			}
			if (typeof p.label === "string") badgeOverride = p.label.trim().slice(0, 60);
			writeSessionRecord(ctx);
			detach(renameTopicIfStale(ctx), "topic rename");
			return { content: [{ type: "text", text: `Badge is now: ${badge(ctx)}` }], details: { badge: badge(ctx) } };
		},
	});

	/** Multipart upload for outbound files; JSON callTelegram cannot carry bytes. */
	async function uploadTelegram<T>(
		cfg: Config,
		method: string,
		fields: Record<string, string | number>,
		files: Array<{ field: string; name: string; data: Uint8Array }>,
		attempt = 0,
	): Promise<T | null> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
		for (const file of files) form.append(file.field, new Blob([file.data as Uint8Array<ArrayBuffer>]), file.name);
		try {
			const response = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
				method: "POST",
				body: form,
				signal: AbortSignal.timeout(120_000),
			});
			const payload: unknown = await response.json().catch(() => null);
			const envelope =
				payload !== null && typeof payload === "object"
					? (payload as { ok?: unknown; result?: unknown; parameters?: { retry_after?: unknown } })
					: null;
			const retryAfter = envelope?.parameters?.retry_after;
			if (response.status === 429 && typeof retryAfter === "number" && retryAfter <= 30 && attempt === 0) {
				await new Promise((wake) => setTimeout(wake, (retryAfter + 0.5) * 1000));
				return await uploadTelegram<T>(cfg, method, fields, files, 1);
			}
			if (envelope === null || envelope.ok !== true) {
				pi.logger.warn("telegram upload failed", { method, status: response.status });
				return null;
			}
			return envelope.result as T;
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			pi.logger.warn("telegram upload failed", { method, error: raw.split(cfg.token).join("<token>") });
			return null;
		}
	}

	pi.registerTool({
		name: "notify_file",
		label: "Notify File",
		description:
			"Send files from disk to the user's Telegram chat, for artifacts the user should see on their phone: a screenshot, a rendered diff, a report, a build output. `paths`: 1 to 10 file paths under the session workspace or the system tmp directory (copy anything else into the workspace first). Images arrive as photos and several images become one album, everything else arrives as a document (50 MB per file, 100 MB per call). `caption`: optional short plain text shown with the first file.",
		approval: "read",
		strict: true,
		parameters: z.object({
			paths: z.array(z.string()).min(1).max(10),
			caption: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { paths: string[]; caption?: unknown };
			if (config === null) {
				return { content: [{ type: "text", text: "Error: Telegram is not configured" }], isError: true };
			}
			const requestedCaption = typeof p.caption === "string" ? p.caption.trim() : "";
			const context = sessionContextLine(ctx);
			const separator = requestedCaption.length > 0 ? "\n\n" : "";
			const callerLimit = Math.max(0, TELEGRAM_CAPTION_MAX - context.length - separator.length);
			let callerCaption = requestedCaption.slice(0, callerLimit);
			const trailing = callerCaption.charCodeAt(callerCaption.length - 1);
			if (trailing >= 0xd800 && trailing <= 0xdbff) callerCaption = callerCaption.slice(0, -1);
			const caption = callerCaption.length > 0 ? `${context}${separator}${callerCaption}` : context;
			const allowedRoots = [ctx.cwd, tmpdir(), MEDIA_DIR];
			const loaded: Array<{ path: string; name: string; data: Uint8Array; photo: boolean }> = [];
			let totalBytes = 0;
			for (const requested of p.paths) {
				const path = resolve(ctx.cwd, requested);
				if (!allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${path} is outside the workspace and tmp directories. Copy the file into the workspace first.`,
							},
						],
						isError: true,
					};
				}
				let size = 0;
				try {
					const info = statSync(path);
					if (!info.isFile()) {
						return { content: [{ type: "text", text: `Error: ${path} is not a regular file` }], isError: true };
					}
					size = info.size;
				} catch {
					return { content: [{ type: "text", text: `Error: cannot read ${path}` }], isError: true };
				}
				if (size > 50 * 1024 * 1024) {
					return { content: [{ type: "text", text: `Error: ${path} exceeds the 50 MB upload limit` }], isError: true };
				}
				totalBytes += size;
				if (totalBytes > 100 * 1024 * 1024) {
					return {
						content: [{ type: "text", text: "Error: the batch exceeds the 100 MB total limit" }],
						isError: true,
					};
				}
				let data: Uint8Array;
				try {
					data = readFileSync(path);
				} catch {
					return { content: [{ type: "text", text: `Error: cannot read ${path}` }], isError: true };
				}
				const name = (path.split("/").at(-1) ?? "file").replaceAll(/[^\w.-]/gu, "_").slice(-80);
				const photo = /\.(png|jpe?g|gif|webp|bmp)$/iu.test(name) && data.byteLength <= 10 * 1024 * 1024;
				loaded.push({ path, name, data, photo });
			}

			const base: Record<string, string | number> = { chat_id: config.chatId };
			if (topicId !== null) base.message_thread_id = topicId;
			const sentIds: number[] = [];
			if (loaded.length > 1 && loaded.every((file) => file.photo)) {
				const media = loaded.map((_file, index) => ({
					type: "photo",
					media: `attach://f${index}`,
					...(index === 0 && caption.length > 0 ? { caption } : {}),
				}));
				const sent = await uploadTelegram<TelegramMessage[]>(
					config,
					"sendMediaGroup",
					{ ...base, media: JSON.stringify(media) },
					loaded.map((file, index) => ({ field: `f${index}`, name: file.name, data: file.data })),
				);
				if (sent === null) {
					return { content: [{ type: "text", text: "Error: Telegram rejected the album upload" }], isError: true };
				}
				for (const message of sent) {
					trackSent(message);
					sentIds.push(message.message_id);
				}
			} else {
				for (const [index, file] of loaded.entries()) {
					const fields: Record<string, string | number> = { ...base };
					if (index === 0 && caption.length > 0) fields.caption = caption;
					const kind = file.photo ? "photo" : "document";
					fields[kind] = "attach://f0";
					let sent = await uploadTelegram<TelegramMessage>(config, file.photo ? "sendPhoto" : "sendDocument", fields, [
						{ field: "f0", name: file.name, data: file.data },
					]);
					// Telegram rejects photos over its dimension limits; the same bytes go through as a document.
					if (sent === null && file.photo) {
						const retry: Record<string, string | number> = { ...base };
						if (index === 0 && caption.length > 0) retry.caption = caption;
						retry.document = "attach://f0";
						sent = await uploadTelegram<TelegramMessage>(config, "sendDocument", retry, [
							{ field: "f0", name: file.name, data: file.data },
						]);
					}
					if (sent === null) {
						return {
							content: [{ type: "text", text: `Error: Telegram rejected the upload of ${file.path}` }],
							isError: true,
						};
					}
					trackSent(sent);
					sentIds.push(sent.message_id);
				}
			}
			lastNotifiedAt = Date.now();
			writeSessionRecord(ctx);
			return {
				content: [{ type: "text", text: `Sent ${loaded.length} file${loaded.length === 1 ? "" : "s"} to Telegram.` }],
				details: { messageIds: sentIds },
			};
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
		sessionCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
		try {
			// mkdir applies the mode only at creation; a dir inherited from an older version stays loose otherwise.
			chmodSync(STATE_DIR, 0o700);
		} catch {}
		mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
		mkdirSync(join(INBOX_DIR, sessionId), { recursive: true, mode: 0o700 });
		reapDeadSessions();
		reapOldMedia();
		sessionTag = claimTag();
		// Base-36 tag as a number: stable across resumes, unique across live sessions.
		draftId = Number.parseInt(sessionTag, 36) + 1;
		badgeEmoji = claimBadge();
		const previous = readSessionRecord(sessionId);
		badgeOverride = previous?.label ?? "";
		if (previous?.standing != null && typeof previous.standing.id === "string") {
			standingQuestion = {
				...previous.standing,
				head: typeof previous.standing.head === "string" ? previous.standing.head : "",
			};
		}
		if (Array.isArray(previous?.recent)) {
			recentMessages.push(...previous.recent.filter((n): n is number => typeof n === "number"));
		}
		lastNotifiedAt = typeof previous?.lastNotified === "number" ? previous.lastNotified : 0;
		pinnedMessageId = typeof previous?.pinned === "number" ? previous.pinned : null;
		closeOfferMessageId = typeof previous?.closeOffer === "number" ? previous.closeOffer : null;
		// Topic state must come back before the first record write below, or a
		// crash-recovered session clobbers it and creates a duplicate forum topic.
		if (typeof previous?.topicId === "number") {
			topicId = previous.topicId;
			topicName = typeof previous.topicName === "string" ? previous.topicName : "";
		}
		if (existsSync(LOCK_FILE) && statSync(LOCK_FILE).isDirectory()) {
			rmSync(LOCK_FILE, { recursive: true, force: true });
		}
		rmSync(LEGACY_LOCK_DIR, { recursive: true, force: true });
		writeSessionRecord(ctx);
		acquireLock();

		detach(
			callTelegram(
				config,
				"setMyCommands",
				{
					commands: [
						{ command: "status", description: "Show what each session is doing" },
						{ command: "fleet", description: "List every tmux omp window and its state" },
						{ command: "hidequestions", description: "Hide open question buttons" },
					],
				},
				15_000,
			),
			"command menu",
		);
		detach(callTelegram(config, "setChatMenuButton", { menu_button: { type: "commands" } }, 15_000), "menu button");

		if (ctx.hasUI) {
			unsubscribeInput = ctx.ui.onTerminalInput(() => {
				lastLocalInput = Date.now();
				return undefined;
			});
		}

		// Timers before any network call: a failed start must still receive.
		ctx.setInterval(() => {
			try {
				writeSessionRecord(ctx);
				detach(renameTopicIfStale(ctx), "topic rename");
				reapOldMedia();
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
				maybeType();
				maybeDraft();
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
		unpinRed(ctx);
		const standing = standingQuestion;
		if (standing !== null) {
			standingQuestion = null;
			writeSessionRecord(ctx);
			detach(
				settleQuestionMessage(standing.messageId, standing.head, "Answered at the terminal."),
				"standing-question close",
			);
		}
	});

	// The agent loop is the only truthful "working" signal: `input` also fires for
	// submissions that never start a turn, which left the typing status stuck on.
	pi.on("agent_start", async (_event, ctx) => {
		turnActive = true;
		statusBlockUsed = false;
		unpinRed(ctx);
		retireCloseOffer(true);
		const standing = standingQuestion;
		if (standing !== null) {
			standingQuestion = null;
			writeSessionRecord(ctx);
			detach(
				settleQuestionMessage(standing.messageId, standing.head, "Superseded by new work."),
				"standing-question close",
			);
		}
		approvalWaiting = false;
		typingSentAt = 0;
		draftText = "";
		draftDirty = false;
		currentTool = "";
		askStream = null;
		askPreview = "";
		turnStartingModel = ctx.model === undefined ? "unavailable" : `${ctx.model.provider}/${ctx.model.id}`;
		turnTools = 0;
		turnUsageByModel.clear();
		noticedKinds.clear();
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		approvalWaiting = false;
		draftText = "";
		draftDirty = false;
		currentTool = "";
		askStream = null;
		askPreview = "";
	});

	pi.on("message_update", async (event) => {
		// The host types these payloads, but the runtime guards stay: harnesses and
		// older hosts may fire sparse events.
		const message: unknown = event.message;
		if (message === null || typeof message !== "object") return;
		if (!("role" in message) || message.role !== "assistant") return;
		if (!("content" in message) || !Array.isArray(message.content)) return;
		let text = "";
		for (const block of message.content) {
			if (block === null || typeof block !== "object" || !("type" in block)) continue;
			if (block.type !== "text" || !("text" in block) || typeof block.text !== "string") continue;
			text = text.length === 0 ? block.text : `${text}\n\n${block.text}`;
		}
		draftText = text;
		draftDirty = true;
		trackAskStream((event as { assistantMessageEvent?: unknown }).assistantMessageEvent, message.content);
	});

	/** Follows a streaming ask tool call so the draft can preview the questions, header first. */
	function trackAskStream(streamEvent: unknown, content: unknown[]): void {
		if (streamEvent === null || typeof streamEvent !== "object") return;
		const ev = streamEvent as { type?: unknown; contentIndex?: unknown; delta?: unknown };
		if (typeof ev.contentIndex !== "number") return;
		if (ev.type === "toolcall_start") {
			// The tool name often lands with the first delta, so the check waits until then.
			askStream = { index: ev.contentIndex, buffer: "" };
			return;
		}
		if (askStream === null || askStream.index !== ev.contentIndex) return;
		if (ev.type === "toolcall_end") {
			askStream = null;
			askPreview = "";
			return;
		}
		if (ev.type !== "toolcall_delta" || typeof ev.delta !== "string") return;
		askStream.buffer += ev.delta;
		const block: unknown = content[askStream.index];
		const name =
			block !== null && typeof block === "object" && "name" in block ? (block as { name?: unknown }).name : undefined;
		if (name !== "ask") {
			// Some other tool's call: stop following it once the name is known.
			if (typeof name === "string") askStream = null;
			return;
		}
		const questions = extractQuestionPreviews(askStream.buffer);
		const blocks: string[] = [];
		const head = sessionCtx === null ? "" : badge(sessionCtx);
		if (head.length > 0 && topicId === null) blocks.push(head);
		blocks.push("\u{1F534} Input needed (the question is still being written)");
		if (questions.length === 1) blocks.push(questions[0] ?? "");
		else if (questions.length > 1) blocks.push(questions.map((q, i) => `${i + 1}. ${q}`).join("\n\n"));
		askPreview = blocks.join("\n\n");
		draftDirty = true;
	}

	pi.on("message_end", async (event) => {
		const message: unknown = event.message;
		if (message === null || typeof message !== "object") return;
		if (!("role" in message) || message.role !== "assistant") return;
		if (!("usage" in message)) return;
		const usage: unknown = message.usage;
		if (usage === null || typeof usage !== "object") return;
		const input = "input" in usage && typeof usage.input === "number" ? usage.input : 0;
		const output = "output" in usage && typeof usage.output === "number" ? usage.output : 0;
		const cost =
			"cost" in usage &&
			usage.cost !== null &&
			typeof usage.cost === "object" &&
			"total" in usage.cost &&
			typeof usage.cost.total === "number"
				? usage.cost.total
				: 0;
		if (input === 0 && output === 0 && cost === 0) return;
		const model =
			"provider" in message &&
			typeof message.provider === "string" &&
			"model" in message &&
			typeof message.model === "string"
				? `${message.provider}/${message.model}`
				: turnStartingModel;
		const recorded = turnUsageByModel.get(model);
		if (recorded === undefined) {
			turnUsageByModel.set(model, { input, output, cost });
			return;
		}
		recorded.input += input;
		recorded.output += output;
		recorded.cost += cost;
	});

	pi.on("tool_execution_start", async (event) => {
		turnTools += 1;
		const intent = typeof event.intent === "string" && event.intent.length > 0 ? `: ${event.intent}` : "";
		currentTool = `${typeof event.toolName === "string" ? event.toolName : "tool"}${intent}`.slice(0, 80);
		draftDirty = true;
	});

	pi.on("tool_execution_end", async () => {
		currentTool = "";
		draftDirty = true;
	});

	pi.on("auto_retry_start", async (event, ctx) => {
		if (typeof event.attempt !== "number" || event.attempt < 2) return;
		transparencyNotice("retry", `Provider trouble, retrying (${event.attempt}/${event.maxAttempts}).`, ctx);
	});

	pi.on("retry_fallback_applied", async (event, ctx) => {
		transparencyNotice("fallback", `Model fell back from ${event.from} to ${event.to}.`, ctx);
	});

	pi.on("retry_fallback_succeeded", async (event, ctx) => {
		transparencyNotice("fallback-ok", `Recovered on ${event.model}.`, ctx);
	});

	pi.on("auto_compaction_start", async (event, ctx) => {
		activeCompaction = { trigger: event.reason, action: event.action };
		transparencyNotice(
			"compaction",
			`Context is being compacted (${event.reason}), the turn may pause briefly. Action: ${event.action}.`,
			ctx,
		);
	});

	pi.on("auto_compaction_end", async (event, ctx) => {
		const compaction = activeCompaction;
		activeCompaction = null;
		if (compaction === null || event.skipped === true || event.willRetry === true) return;
		let failure = "aborted";
		if (event.aborted !== true) {
			if (typeof event.errorMessage !== "string") return;
			failure = event.errorMessage.slice(0, PREVIEW_MAX);
		}
		const action = typeof event.action === "string" ? event.action : compaction.action;
		transparencyNotice(
			"compaction-fail",
			`Context compaction failed.\nTrigger: ${compaction.trigger}\nAction: ${action}\nFailure: ${failure}`,
			ctx,
		);
	});

	pi.on("session_stop", async (_event, ctx) => {
		turnActive = false;
		approvalWaiting = false;
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
				const extra: Record<string, unknown> = { ...urgencyExtras(recorded.urgency) };
				if (recorded.urgency === "green") extra.reply_markup = { inline_keyboard: [[closeSessionButton()]] };
				const work = notify(ctx, `${heads[recorded.urgency]}${suffix}`, recorded.text + usageFooter(), extra).then(
					(sent) => {
						if (recorded.urgency === "red") return pinRed(ctx, sent);
						if (recorded.urgency === "green" && typeof sent?.message_id === "number") {
							closeOfferMessageId = sent.message_id;
							writeSessionRecord(ctx);
						}
						return undefined;
					},
				);
				detach(work, "turn-end notice");
				return;
			}
			detach(
				sendStandingQuestion(ctx, heads[recorded.urgency] + suffix, {
					...recorded,
					text: recorded.text + usageFooter(),
				}),
				"turn-end question",
			);
			return;
		}

		if (!statusBlockUsed) {
			statusBlockUsed = true;
			return {
				decision: "block" as const,
				reason:
					"Before finishing, call notify_status with a one-or-two-sentence summary when no choice is attached and an urgency (green done, orange reply wanted, red blocked). Be proactive about next steps: name the concrete ones when they exist, and say plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. When you believe the work is complete, weigh the follow-ups that fit what the turn was. After a bug fix, offer to hunt for surviving bugs of the same family, to complete the test coverage around the fix, and to run mutation testing to grade that coverage. After a feature, offer the related feature that naturally follows once this one is committed, a switch to a cleaner abstraction you found (a trait, generics, a blanket impl) before committing, a pass hunting for cleaner code, criterion benchmarks, or a strict review of the change as the repository's maintainer would run it. If any user action is wanted, also set question and 2 to 6 short options drawn from those real next steps. The notification must be answerable from a phone without terminal context. Options are bare labels, so the summary must name the decision, explain why it is needed now, and state what each option does or costs. Each option must name the action. Never use only a phase number or letter, such as `Start Phase 7`. The buttons start the next turn, and the most likely choice goes first. Omit them when there is genuinely nothing to ask.",
			};
		}

		const tail = lastAssistantTail(ctx);
		const wantsReply = /\?\s*$/m.test(tail);
		const title = `${wantsReply ? "\u{1F7E0} Reply wanted" : "\u{1F7E2} Turn finished"}${suffix}`;
		detach(
			notify(ctx, title, (tail.length > 0 ? tail : "Awaiting your next instruction.") + usageFooter()),
			"turn-end notice",
		);
	});

	pi.on("tool_approval_requested", async (event, ctx) => {
		approvalWaiting = true;
		if (config === null) return;
		const tool = event.toolName;
		const notice: ApprovalNotice = {
			toolCallId: event.toolCallId,
			toolName: tool,
			messageId: null,
			resolution: null,
		};
		approvalNotice = notice;
		const where = tmuxLocation();
		const work = notify(
			ctx,
			`\u{1F534} Approval needed${where === null ? "" : ` (tmux ${where})`}`,
			`${tool} is waiting for approval.`,
		).then((sent) => {
			notice.messageId = typeof sent?.message_id === "number" ? sent.message_id : null;
			if (notice.messageId === null && notice.resolution !== null && approvalNotice === notice) {
				approvalNotice = null;
				return;
			}
			finishApprovalNotice(ctx, notice);
		});
		detach(work, "approval notice");
	});

	pi.on("tool_approval_resolved", async (event, ctx) => {
		approvalWaiting = false;
		const notice = approvalNotice;
		if (notice === null || notice.toolCallId !== event.toolCallId) return;
		notice.resolution = { approved: event.approved, reason: event.reason?.trim() ?? "" };
		finishApprovalNotice(ctx, notice);
	});

	pi.on("credential_disabled", async (event, ctx) => {
		if (config === null) return;
		const provider =
			event !== null && typeof event === "object" && "provider" in event && typeof event.provider === "string"
				? event.provider
				: "unavailable";
		detach(sessionNotice(ctx, `Credential disabled for ${provider}.`), "credential notice");
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = null;
		retireCloseOffer(topicId === null);
		const ask = pendingAsk;
		if (ask !== null) {
			pendingAsk = null;
			const messageId = ask.messageId;
			const head = ask.settlementHeads[ask.index];
			ask.messageId = null;
			if (config !== null && topicId === null && head !== undefined) {
				detach(settleQuestionMessage(messageId, head, "This question is no longer active."), "pending-question close");
			}
		}
		const standing = standingQuestion;
		if (standing !== null) {
			standingQuestion = null;
			if (sessionCtx !== null) writeSessionRecord(sessionCtx);
			// A topic session's shutdown deletes the whole thread below, question included.
			if (config !== null && topicId === null) {
				detach(
					settleQuestionMessage(standing.messageId, standing.head, "**Session closed.**"),
					"standing-question close",
				);
			}
		}
		if (topicId === null && sessionCtx !== null) unpinRed(sessionCtx);
		if (config !== null && topicId !== null) {
			mkdirSync(PENDING_TOPICS_DIR, { recursive: true, mode: 0o700 });
			writeFileAtomic(join(PENDING_TOPICS_DIR, `${sessionId}.json`), JSON.stringify(topicId), 0o600);
			detach(
				callTelegram(config, "deleteForumTopic", { chat_id: config.chatId, message_thread_id: topicId }, 5_000),
				"topic delete",
			);
			unlinkSync(join(SESSIONS_DIR, `${sessionId}.json`));
		}
		releaseLock();
	});
}
