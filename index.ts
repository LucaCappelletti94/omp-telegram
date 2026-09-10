import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type AskOption,
	type AskQuestion,
	badgeLine,
	buttonText,
	clip,
	clipEnd,
	duration,
	extractQuestionPreviews,
	fenceFor,
	fitToTelegram,
	type InlineButton,
	isMarkupFailure,
	packRows,
	plainStamps,
	relativeTime,
	STANCE,
	type StatusOption,
	stanceFor,
	stanceOf,
	TELEGRAM_TEXT_MAX,
	toTelegramHtml,
} from "./render.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
const CONFIG_PATH = join(AGENT_DIR, "notify-telegram.json");
const STATE_DIR = join(AGENT_DIR, "notify-telegram");
const PENDING_MESSAGES_DIR = join(STATE_DIR, "pending-messages");
const LOCK_FILE = join(STATE_DIR, "poller.lock");
const LEGACY_LOCK_DIR = join(STATE_DIR, "poller.lock.d");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const DASHBOARD_FILE = join(STATE_DIR, "dashboard.json");
const DASHBOARD_LOCK_FILE = join(STATE_DIR, "dashboard.lock");
const INBOX_DIR = join(STATE_DIR, "inbox");
const MEDIA_DIR = join(STATE_DIR, "media");
/** Every session message as sent, keyed by message id: a reaction names only the id. */
const SENT_DIR = join(STATE_DIR, "sent");
const SENT_IN_FLIGHT_DIR = join(STATE_DIR, "sent-in-flight");
const REACTION_PENDING_DIR = join(STATE_DIR, "reaction-pending");
const REACTION_ROUTE_LOCK_DIR = join(STATE_DIR, "reaction-route-locks");
/** One line per reaction change, holding the grade and the message it graded. */
const FEEDBACK_FILE = join(STATE_DIR, "feedback.jsonl");
/** The channel a process outside omp uses to ask one question and read its answer back. */
const EXTERNAL_DIR = join(STATE_DIR, "external");
const EXTERNAL_ANSWERS_DIR = join(EXTERNAL_DIR, "answers");
/** An external question's key becomes a filename, so it stays a plain token no path can escape. */
const EXTERNAL_KEY = /^[A-Za-z0-9._-]{1,64}$/u;
/** Held only across a badge validate-and-persist, which is two file writes long. */
const BADGE_LOCK_FILE = join(STATE_DIR, "badge.lock");

const REACTION_ROUTE_WAIT_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 45_000;
const DRAIN_MS = 1_000;
/** Refreshed every heartbeat while work is active, with enough slack for delayed timer ticks. */
const SENT_MARKER_STALE_MS = 2 * 60_000;
const BADGE_CLAIM_STALE_MS = 5_000;
const LONG_POLL_S = 25;
const STATUS_OPTIONS_MIN = 2;
const STATUS_OPTIONS_MAX = 6;
/** Carried by the dead buttons a settled question keeps, so a press on one is recognisable. */
const SETTLED_CALLBACK = "x";
/** Two turns finishing this close together is the only genuinely ambiguous case. */
const AMBIGUOUS_WINDOW_MS = 60_000;
const HELD_MESSAGE_TTL_MS = 3_600_000;
/** Recorded state that outranks recency when routing a plain message. */
const WAITING_ON_QUESTION = "waiting on a question";
const PREVIEW_MAX = 300;
const SUMMARY_MAX = 900;
/**
 * The exact frames omp writes into the pane title while a turn runs
 * (`title-generator.ts` `TITLE_SPINNER_FRAMES`). omp-tmux matches the same literal set, so both
 * surfaces classify a window identically. A wider braille range would call any braille glyph work.
 */
const SPINNER_FRAMES = new Set([
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
]);
const STATUS_SUMMARY_MAX = 160;
const CAPTION_MAX = 1024;
/** A snippet's purpose is one line above the block, not a second summary. */
const SNIPPET_PURPOSE_MAX = 120;
const RECENT_MESSAGE_CAP = 60;
/**
 * A turn that ends on a question the user can only read in the terminal never reaches the phone, so
 * the agent gets blocked once and pointed at the two channels that do reach it.
 */
const QUESTION_STOP_REASON =
	"Your turn is ending on a question to the user, but it is written only as terminal prose, which the user does not see on Telegram when away from the desktop. Do not answer your own question and carry on as though it were settled. If you need the answer before proceeding, call the ask tool, which stops the turn and is answerable from the terminal or the phone. If the question itself is what ends the turn, call notify_status with an orange urgency, the question set, and two to six options, each an object with a short label naming a choice and a one-line description of what choosing it does or costs, so the user can answer from a phone.";

const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_KEEP_MS = 7 * 24 * 3600 * 1000;
const SENT_KEEP_MS = 90 * 24 * 3600 * 1000;
/** User-approved Telegram reactions, normalised without the optional U+FE0F selector. */
const REACTION_SCALE: ReadonlyArray<readonly [number, readonly string[]]> = [
	[3, ["\u{1F3C6}", "\u{1F4AF}", "\u{1F929}", "\u2764\u200D\u{1F525}", "\u{1F389}", "\u{1F525}"]],
	[
		2,
		["\u{1F44D}", "\u2764", "\u{1F44F}", "\u{1F60D}", "\u{1F970}", "\u{1F44C}", "\u{1F64F}", "\u{1F601}", "\u{1F923}"],
	],
	[1, ["\u{1F60E}", "\u{1F91D}", "\u{1FAE1}", "\u{1F192}", "\u{1F440}", "\u{1F913}"]],
	[0, ["\u{1F914}", "\u{1F928}", "\u{1F610}", "\u{1F937}", "\u{1F937}\u200D\u2642", "\u{1F937}\u200D\u2640"]],
	[-1, ["\u{1F971}", "\u{1F634}", "\u{1F648}", "\u{1F622}", "\u{1F494}"]],
	[-2, ["\u{1F44E}", "\u{1F628}", "\u{1F631}", "\u{1F62D}", "\u{1F92F}"]],
	[-3, ["\u{1F4A9}", "\u{1F92E}", "\u{1F921}", "\u{1F92C}", "\u{1F621}", "\u{1F595}"]],
];
const REACTION_GRADES: Readonly<Record<string, number>> = Object.fromEntries(
	REACTION_SCALE.flatMap(([grade, emoji]) => emoji.map((e) => [e, grade])),
);
/** A grade this low on an agent message sends the agent back to write it again. */
const REDO_GRADE = -2;

/** What a message was, so a grade on it can be read later and a redo can name the tool. */
type SentKind = "status" | "question" | "standing" | "snippet" | "file" | "approval" | "notice";
const SENT_KINDS: Readonly<Record<SentKind, true>> = {
	status: true,
	question: true,
	standing: true,
	snippet: true,
	file: true,
	approval: true,
	notice: true,
};

interface SentRecord {
	version: 1;
	id: number;
	at: number;
	kind: SentKind;
	/** The plain source as sent, head and footer included: what the reader graded. */
	text: string;
	session: { id: string; tag: string; emoji: string; name: string; cwd: string };
	/** The structured call behind the message, where there was one. */
	payload?: unknown;
}

interface TelegramReaction {
	chat: { id: number };
	message_id: number;
	user?: { id: number };
	date: number;
	old_reaction: TelegramReactionType[];
	new_reaction: TelegramReactionType[];
}

function isTelegramMessageId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isStateToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

type TelegramReactionType =
	| { type: "emoji"; emoji: string }
	| { type: "custom_emoji"; custom_emoji_id: string }
	| { type: "paid" };

const TYPING_MS = 5_000;
const DRAFT_MS = 1_500;
/** The party-popper send effect, verified against the live API; effects exist in private chats only. */
const GREEN_EFFECT_ID = "5046509860389126442";

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
/** Anything a badge emoji has to contain: a picture, a flag half, or a keycap. */
const BADGE_PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * A badge is one glyph beside the folder name, so a badge is one emoji. Grapheme counting is what
 * admits a flag or a keycap, whose leading code point is neither pictographic nor an emoji on its
 * own, while still refusing a word: "rat" used to be truncated to two code points and shipped.
 */
function isBadgeEmoji(value: string): boolean {
	return [...GRAPHEMES.segment(value)].length === 1 && BADGE_PICTURE.test(value);
}

interface Config {
	token: string;
	chatId: number;
	offset: number;
	quietSeconds: number;
	notifyOnTurnEnd: boolean;
	streamDrafts: boolean;
	pinnedDashboard: boolean;
	/** Minimum gap between board rewrites, which is what actually protects the rate limit. */
	dashboardSeconds: number;
}

interface SessionRecord {
	pid: number;
	tag: string;
	name: string;
	cwd: string;
	emoji: string;
	/** True once an agent picked the emoji for its task; a palette placeholder is not a choice. */
	emojiChosen: boolean;
	label: string;
	lastNotified: number;
	/** Replying to one of these routes back here. */
	recent: number[];
	/** Message id of the native ask currently waiting for an answer. */
	question: number | null;
	/** Buttonless turn-end question still waiting for a Telegram reply. */
	replyQuestion: number | null;
	/** Standing turn-end question; survives a resume. */
	standing: StandingQuestion | null;
	/** Message carrying a live close-session button on a plain green summary. */
	closeOffer: number | null;
	/** Message pinned for a red status; unpinned when the next turn starts. */
	pinned: number | null;
	/** What this session is doing, so one session can answer `/status` for the whole fleet. */
	state: string;
	/** Provider weather for the current turn: a retry, a fallback, or a recovery. */
	health: string;
	/** First line of the last turn-end summary, and when it landed. */
	summary: string;
	summaryAt: number;
	heartbeat: number;
}

interface TelegramMessage {
	message_id: number;
	date: number;
	chat: { id: number };
	reply_to_message?: { message_id: number };
	text?: string;
	caption?: string;
	photo?: Array<{ file_id: string; file_size?: number }>;
	voice?: { file_id: string; file_size?: number; mime_type?: string };
	audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
	document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
	/** Telegram's own narration of a pin, which this extension causes itself. */
	pinned_message?: unknown;
}

interface TelegramCallbackQuery {
	id: string;
	data?: string;
	from?: { id: number };
	message?: {
		message_id: number;
		chat: { id: number };
		reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] };
	};
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
	message_reaction?: TelegramReaction;
}

interface AskResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

/** Past the ask tool's own refusal every option carries a description, so nothing downstream weighs its absence. */
type ExplainedQuestion = Omit<AskQuestion, "options"> & { options: (AskOption & { description: string })[] };

interface PendingAsk {
	askId: string;
	/** Kept so every re-render of the question opens with the head this session shows everywhere. */
	ctx: ExtensionContext;
	context: string;
	questions: ExplainedQuestion[];
	index: number;
	messageId: number | null;
	selected: Set<string>[];
	custom: Array<string | undefined>;
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
	options?: StatusOption[];
}

/**
 * A bare string is the label, which the caller then refuses for carrying no description. Anything
 * else must be an object holding one. `null` means malformed.
 */
function parseStatusOption(raw: unknown): StatusOption | null {
	if (typeof raw === "string") {
		const label = raw.trim();
		return label.length > 0 ? { label } : null;
	}
	if (raw === null || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const label = typeof source.label === "string" ? source.label.trim() : "";
	if (label.length === 0) return null;
	const description = typeof source.description === "string" ? source.description.trim() : "";
	return {
		label,
		description: description.length > 0 ? description : undefined,
		recommended: source.recommended === true,
		lukewarm: source.lukewarm === true,
		discouraged: source.discouraged === true,
	};
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
	kind: "text" | "callback" | "file" | "command" | "redo";
	/** Text, callback payload, downloaded file path, command name, or the redo note. */
	value: string;
	/** Incoming Telegram message id for delivery receipts. For a redo, the graded message. */
	messageId?: number;
	/** Original sent-message kind, used to reject a question redo that became stale in transit. */
	targetKind?: SentKind;
	/** True when a status message is itself a buttonless question. */
	targetQuestion?: boolean;
	/** True when eligibility was established from the record visible before an accepted edit. */
	targetPreEdit?: boolean;
	/** Message id the sender replied to. */
	replyTo?: number;
	caption?: string;
	mime?: string;
}
interface ReactionTransaction extends Partial<InboxEntry> {
	transaction: 1;
	updateId: number;
	feedback: Record<string, unknown>;
}

interface IncomingFile {
	kind: "photo" | "voice" | "audio" | "document";
	fileId: string;
	mime: string;
	size?: number;
	name?: string;
}

/** Largest photo size wins; Telegram photos are always JPEG. */
function pickMedia(message: TelegramMessage): IncomingFile | null {
	const photo = message.photo?.at(-1);
	if (photo !== undefined) return { kind: "photo", fileId: photo.file_id, mime: "image/jpeg", size: photo.file_size };
	const voice = message.voice;
	if (voice !== undefined)
		return { kind: "voice", fileId: voice.file_id, mime: voice.mime_type ?? "audio/ogg", size: voice.file_size };
	const audio = message.audio;
	if (audio !== undefined) {
		return {
			kind: "audio",
			fileId: audio.file_id,
			mime: audio.mime_type ?? "audio/mpeg",
			size: audio.file_size,
			name: audio.file_name,
		};
	}
	const document = message.document;
	if (document !== undefined) {
		return {
			kind: "document",
			fileId: document.file_id,
			mime: document.mime_type ?? "application/octet-stream",
			size: document.file_size,
			name: document.file_name,
		};
	}
	return null;
}

/**
 * Telegram narrates its own pins back into the chat as contentless messages: the fleet board and
 * a red status. This extension causes both, and neither is user input, so they must not be
 * mistaken for an unsupported message type.
 */
function isChatEvent(message: TelegramMessage): boolean {
	return message.pinned_message !== undefined;
}

/** Temp plus rename: a reader in another omp process must never see a torn file. */
function writeFileAtomic(path: string, content: string, mode?: number): void {
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(temp, content, mode === undefined ? {} : { mode });
	renameSync(temp, path);
}

/** Colons are illegal in filenames on Windows and awkward in shells; the rest of ISO-8601 sorts as it reads. */
function utcStamp(at: number): string {
	return new Date(at)
		.toISOString()
		.replace(/\.\d{3}Z$/u, "Z")
		.replaceAll(":", "-");
}

/** Both ways a session is identified: the tag routing uses, the emoji the chat shows. */
function fileOwner(tag: string, emoji: string): string {
	const named = tag.length === 0 ? "unknown" : tag;
	return emoji.length === 0 ? named : `${named}-${emoji}`;
}

const STANDARD_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__[^_]+__[^_]+__(?:u\d+__)?/u;

/**
 * One shape for every file this extension writes or uploads: when, what, whose, which update, then
 * the original name, so a chat search or a `grep` on any of those finds it.
 */
function standardFileName(parts: {
	at: number;
	kind: string;
	owner: string;
	updateId?: number;
	original: string;
}): string {
	// A file received from Telegram can be sent back, and two stacked prefixes name nothing extra.
	const bare = parts.original.replace(STANDARD_NAME, "");
	const dot = bare.lastIndexOf(".");
	const stem = (dot > 0 ? bare.slice(0, dot) : bare).replaceAll(/[^\w-]/gu, "_").slice(0, 60) || "file";
	const ext =
		dot > 0
			? bare
					.slice(dot)
					.replaceAll(/[^\w.]/gu, "_")
					.slice(0, 16)
			: "";
	const update = parts.updateId === undefined ? "" : `u${parts.updateId}__`;
	return `${utcStamp(parts.at)}__${parts.kind}__${parts.owner}__${update}${stem}${ext}`;
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
		// Opt-in: a permanently pinned message is too strong an opinion to impose by default.
		pinnedDashboard: raw.pinnedDashboard === true,
		dashboardSeconds: typeof raw.dashboardSeconds === "number" ? raw.dashboardSeconds : 30,
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

interface TelegramFailure {
	method: string;
	status: number;
	description: string;
}

interface TelegramEnvelope {
	ok?: unknown;
	result?: unknown;
	description?: unknown;
	parameters?: { retry_after?: unknown };
}

/**
 * Telegram throttles a bot to roughly one message per second per chat. Several sessions ending a
 * turn together will hit it, and dropping those notifications silently is the wrong answer, so a
 * short retry-after is honoured exactly once. `send` is re-invoked rather than reused, since a
 * request body is spent by its first attempt.
 */
async function sendWithRetry(
	send: () => Promise<Response>,
): Promise<{ response: Response; envelope: TelegramEnvelope | null }> {
	for (let attempt = 0; ; attempt++) {
		const response = await send();
		const payload: unknown = await response.json().catch(() => null);
		const envelope = payload !== null && typeof payload === "object" ? (payload as TelegramEnvelope) : null;
		const retryAfter = envelope?.parameters?.retry_after;
		if (attempt > 0 || response.status !== 429 || typeof retryAfter !== "number" || retryAfter > 30) {
			return { response, envelope };
		}
		await new Promise((wake) => setTimeout(wake, (retryAfter + 0.5) * 1000));
	}
}

/**
 * The one place a Telegram call is made. Every caller decides what a failure means from the
 * description, rather than from the bare absence of a result.
 */
async function callTelegramRaw<T>(
	config: Config,
	method: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	onFailure: (failure: TelegramFailure) => void,
): Promise<T | null> {
	const { response, envelope } = await sendWithRetry(() =>
		fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		}),
	);
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

/** Renders the keyboard for one question. Selected labels get a check mark so multi-select reads correctly. */
function questionKeyboard(ask: PendingAsk, question: AskQuestion): InlineButton[][] {
	const chosen = ask.selected[ask.index] ?? new Set<string>();
	const optionButtons = question.options.map((option, optionIndex) => {
		const mark = question.multi === true && chosen.has(option.label) ? "[x] " : "";
		const stance = stanceOf(question, option, optionIndex);
		const suffix = stance === null ? "" : ` ${stance.marker}`;
		const button: InlineButton = {
			text: buttonText(`${mark}${option.label}`, suffix),
			callback_data: `o:${ask.askId}:${ask.index}:${optionIndex}`,
		};
		if (stance?.style !== undefined) button.style = stance.style;
		return button;
	});
	const rows = packRows(optionButtons);
	if (question.multi === true) {
		rows.push([{ text: "Done", callback_data: `d:${ask.askId}:${ask.index}`, style: "success" }]);
	}
	return rows;
}

/** The options stay visible but dead, with the chosen answers ticked. */
function settledKeyboard(labels: string[], chosen: Set<string>): InlineButton[][] {
	return packRows(
		labels.map((label) => ({
			text: buttonText(`${chosen.has(label) ? "\u2713 " : ""}${label}`),
			callback_data: SETTLED_CALLBACK,
		})),
	);
}

/** One subprocess, captured. `ok` is the exit status; stderr carries the reason a step can report. */
interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<RunResult> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			encoding: "utf8",
			timeout: 300_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { ok: true, stdout: stdout.toString().trim(), stderr: "" };
	} catch (error) {
		const e = error as { stdout?: unknown; stderr?: unknown; message?: string };
		const text = (value: unknown): string => (value === undefined || value === null ? "" : value.toString().trim());
		return { ok: false, stdout: text(e.stdout), stderr: text(e.stderr) || e.message || "command failed" };
	}
}

/** A pause between subprocess retries that yields the thread, so the Telegram poller keeps running. */
async function sleepMs(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A remote url and an `owner/name` name the same repository whether it is ssh or https, with or without `.git`. */
function sameRepo(url: string, owner: string, name: string): boolean {
	const normalised = url
		.trim()
		.replace(/\.git$/u, "")
		.toLowerCase();
	const target = `${owner}/${name}`.toLowerCase();
	return normalised.endsWith(`:${target}`) || normalised.endsWith(`/${target}`);
}

/** Excludes a path through the checkout's private exclude, shared across worktrees, never through tracked `.gitignore`. */
function excludePath(clonePath: string, entry: string): void {
	const file = join(clonePath, ".git", "info", "exclude");
	let current = "";
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	if (current.split("\n").some((line) => line.trim() === entry.trim())) return;
	try {
		mkdirSync(join(clonePath, ".git", "info"), { recursive: true });
		writeFileSync(file, `${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
	} catch {}
}

/** A short kebab identifier for the branch and worktree, derived from the problem when the caller gives none. */
function upstreamSlug(text: string, name: string): string {
	const base = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 40)
		.replace(/-+$/u, "");
	return base.length > 0 ? base : `${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-fix`;
}

interface LaunchArgs {
	owner: string;
	name: string;
	slug: string;
	doc: string;
	problem: string;
}

type LaunchOutcome =
	| {
			ok: true;
			owner: string;
			name: string;
			login: string;
			mode: "own" | "fork";
			created: boolean;
			clonePath: string;
			worktreePath: string;
			branch: string;
			windowId: string;
	  }
	| { ok: false; error: string };

/** Validates the tool's parameters into launch arguments, or an error string a caller reports verbatim. */
function validateLaunchParams(
	p: { repo?: unknown; document?: unknown; problem?: unknown; slug?: unknown },
	cwd: string,
): { ok: true; args: LaunchArgs; docPath: string } | { ok: false; error: string } {
	const repo = typeof p.repo === "string" ? p.repo.trim() : "";
	const match = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/u.exec(repo);
	if (match === null) return { ok: false, error: `repo must be the uphill repository as "owner/name", not "${repo}"` };
	const owner = match[1] ?? "";
	const name = match[2] ?? "";
	const document = typeof p.document === "string" ? p.document.trim() : "";
	const docPath = document.length > 0 ? resolve(cwd, document) : "";
	if (docPath.length === 0 || !existsSync(docPath)) {
		return {
			ok: false,
			error: `no request document at ${docPath || "(empty path)"}; write the upstream request document first, then pass its path`,
		};
	}
	let doc = "";
	try {
		doc = readFileSync(docPath, "utf8");
	} catch {
		return { ok: false, error: `could not read the request document at ${docPath}` };
	}
	if (doc.trim().length === 0) {
		return {
			ok: false,
			error:
				"the request document is empty; it must state the problem, examples of the failure, and examples of the corrected behaviour",
		};
	}
	const problem = typeof p.problem === "string" ? p.problem.trim() : "";
	if (problem.length === 0)
		return { ok: false, error: "problem must be one sentence naming what the dependency does wrong" };
	const slug = upstreamSlug(typeof p.slug === "string" && p.slug.trim().length > 0 ? p.slug : problem, name);
	return { ok: true, args: { owner, name, slug, doc, problem }, docPath };
}

interface LaunchTarget {
	login: string;
	isOwn: boolean;
	cloneOwner: string;
	created: boolean;
}

/** A gh failure that means the repository is genuinely absent, the only case that justifies forking. */
const GH_ABSENT = /not found|could not resolve|no such|404/iu;

/** Resolves the target on the user's account: their own repository, an existing fork, or a fork it creates. */
async function resolveTarget(
	a: LaunchArgs,
): Promise<{ ok: true; target: LaunchTarget } | { ok: false; error: string }> {
	const who = await run("gh", ["api", "user", "-q", ".login"]);
	if (!who.ok || who.stdout.length === 0) {
		return {
			ok: false,
			error: `could not read your GitHub login from gh (${who.stderr || "no output"}); check that gh is authenticated`,
		};
	}
	const login = who.stdout;
	if (a.owner.toLowerCase() === login.toLowerCase()) {
		return { ok: true, target: { login, isOwn: true, cloneOwner: a.owner, created: false } };
	}
	const view = await run("gh", [
		"repo",
		"view",
		`${login}/${a.name}`,
		"--json",
		"isFork,parent",
		"-q",
		'[(.isFork | tostring), (if .parent then .parent.owner.login + "/" + .parent.name else "" end)] | @tsv',
	]);
	if (view.ok) {
		const [isFork, parent] = view.stdout.split("\t");
		if (isFork !== "true" || (parent ?? "").toLowerCase() !== `${a.owner}/${a.name}`.toLowerCase()) {
			return {
				ok: false,
				error: `${login}/${a.name} already exists but is not a fork of ${a.owner}/${a.name}; move or rename it, then retry`,
			};
		}
		return { ok: true, target: { login, isOwn: false, cloneOwner: login, created: false } };
	}
	// A non-OK view is only "fork does not exist" when gh says so; a network or auth failure must not fork.
	if (!GH_ABSENT.test(view.stderr)) {
		return {
			ok: false,
			error: `could not check whether ${login}/${a.name} exists (${view.stderr || "no output"}); resolve the gh error and retry`,
		};
	}
	const fork = await run("gh", ["repo", "fork", `${a.owner}/${a.name}`, "--clone=false"]);
	if (!fork.ok) return { ok: false, error: `gh repo fork ${a.owner}/${a.name} failed: ${fork.stderr}` };
	return { ok: true, target: { login, isOwn: false, cloneOwner: login, created: true } };
}

/** Ensures the clone exists with the right remotes, fetches, and returns the base ref to branch from. */
async function prepareClone(
	a: LaunchArgs,
	target: LaunchTarget,
): Promise<{ ok: true; clonePath: string; base: string } | { ok: false; error: string }> {
	const clonePath = join(homedir(), "github", a.name);
	const originUrl = `git@github.com:${target.cloneOwner}/${a.name}.git`;
	const upstreamUrl = `git@github.com:${a.owner}/${a.name}.git`;
	if (existsSync(clonePath)) {
		const remote = await run("git", ["-C", clonePath, "remote", "get-url", "origin"]);
		if (!remote.ok) return { ok: false, error: `${clonePath} exists but is not a git checkout` };
		if (!sameRepo(remote.stdout, target.cloneOwner, a.name)) {
			return {
				ok: false,
				error: `${clonePath} holds ${remote.stdout}, not ${target.cloneOwner}/${a.name}; move it aside first`,
			};
		}
	} else {
		const attempts = target.created ? 6 : 1;
		let cloned = await run("git", ["clone", originUrl, clonePath]);
		// A freshly created fork can lag behind its own API object, so a first clone may 404.
		for (let attempt = 1; attempt < attempts && !cloned.ok; attempt++) {
			await sleepMs(2000);
			cloned = await run("git", ["clone", originUrl, clonePath]);
		}
		if (!cloned.ok) return { ok: false, error: `git clone ${originUrl} failed: ${cloned.stderr}` };
	}
	if (!target.isOwn) {
		const current = await run("git", ["-C", clonePath, "remote", "get-url", "upstream"]);
		if (!current.ok) await run("git", ["-C", clonePath, "remote", "add", "upstream", upstreamUrl]);
		else if (!sameRepo(current.stdout, a.owner, a.name)) {
			await run("git", ["-C", clonePath, "remote", "set-url", "upstream", upstreamUrl]);
		}
	}
	const remoteName = target.isOwn ? "origin" : "upstream";
	const fetched = await run("git", ["-C", clonePath, "fetch", remoteName]);
	if (!fetched.ok) return { ok: false, error: `git fetch ${remoteName} failed: ${fetched.stderr}` };
	const def = await run("gh", [
		"repo",
		"view",
		`${a.owner}/${a.name}`,
		"--json",
		"defaultBranchRef",
		"-q",
		".defaultBranchRef.name",
	]);
	if (!def.ok || def.stdout.length === 0) {
		return {
			ok: false,
			error: `could not read the default branch of ${a.owner}/${a.name}: ${def.stderr || "no output"}`,
		};
	}
	return { ok: true, clonePath, base: `${remoteName}/${def.stdout}` };
}

/** Cuts the worktree off the base, carries the request in, and opens the tmux tab, rolling back on failure. */
async function openWorktree(
	a: LaunchArgs,
	clonePath: string,
	base: string,
): Promise<{ ok: true; worktreePath: string; branch: string; windowId: string } | { ok: false; error: string }> {
	const branch = `upstream/${a.slug}`;
	const worktreeParent = join(homedir(), "github", `${a.name}.upstreams`);
	const worktreePath = join(worktreeParent, a.slug);
	if (existsSync(worktreePath)) {
		return { ok: false, error: `a worktree already exists at ${worktreePath}; remove it or choose another slug` };
	}
	mkdirSync(worktreeParent, { recursive: true });
	const rollback = async (): Promise<void> => {
		await run("git", ["-C", clonePath, "worktree", "remove", "--force", worktreePath]);
		await run("git", ["-C", clonePath, "branch", "-D", branch]);
	};
	// -B recreates the branch from the freshly fetched base, so a stale branch a prior aborted launch
	// left behind never checks out at its old tip.
	const added = await run("git", ["-C", clonePath, "worktree", "add", "-B", branch, worktreePath, base]);
	if (!added.ok) return { ok: false, error: `git worktree add failed: ${added.stderr}` };
	try {
		mkdirSync(join(worktreePath, "upstream"), { recursive: true });
		writeFileSync(join(worktreePath, "upstream", "request.md"), a.doc);
	} catch (error) {
		await rollback();
		return { ok: false, error: `could not write the request into the worktree: ${(error as Error).message}` };
	}
	excludePath(clonePath, "upstream/");
	const kickoff = [
		`You are the upstream agent for ${a.owner}/${a.name}.`,
		"Read upstream/request.md in this worktree and the skill skill://upstream-agent, then carry out the upstream procedure.",
		`In one sentence, the request is: ${a.problem}`,
	].join(" ");
	const window = await run("tmux", [
		"new-window",
		"-c",
		worktreePath,
		"-n",
		`${a.name}\u2191`,
		"-P",
		"-F",
		"#{window_id}",
		"omp",
		"@upstream/request.md",
		kickoff,
	]);
	if (!window.ok) {
		await rollback();
		return { ok: false, error: `tmux new-window failed: ${window.stderr}` };
	}
	return { ok: true, worktreePath, branch, windowId: window.stdout };
}

/**
 * The mechanical half of the procedure, run on the extension thread but off the synchronous path: resolve or
 * create the fork, ensure the clone, cut a worktree off the latest default branch, carry the request in, and
 * open a new omp session in a tmux tab. It writes only under the user's own account and `~/github`.
 */
async function performUpstreamLaunch(a: LaunchArgs): Promise<LaunchOutcome> {
	const resolved = await resolveTarget(a);
	if (!resolved.ok) return { ok: false, error: resolved.error };
	const prepared = await prepareClone(a, resolved.target);
	if (!prepared.ok) return { ok: false, error: prepared.error };
	const opened = await openWorktree(a, prepared.clonePath, prepared.base);
	if (!opened.ok) return { ok: false, error: opened.error };
	return {
		ok: true,
		owner: a.owner,
		name: a.name,
		login: resolved.target.login,
		mode: resolved.target.isOwn ? "own" : "fork",
		created: resolved.target.created,
		clonePath: prepared.clonePath,
		worktreePath: opened.worktreePath,
		branch: opened.branch,
		windowId: opened.windowId,
	};
}

export default function notifyTelegram(pi: ExtensionAPI): void {
	const z = pi.zod;

	let config: Config | null = null;
	let sessionTag = "";
	let sessionId = "";
	let lastLocalInput = Date.now();
	let pollInFlight = false;
	let drainInFlight = false;
	/** External question keys already answered this session, so the first press on one wins. */
	const externalAnswered = new Set<string>();
	let askSequence = 0;
	let pendingAsk: PendingAsk | null = null;
	let unsubscribeInput: (() => void) | null = null;
	let turnSummary: TurnStatus | null = null;
	let standingSeq = 0;
	let standingQuestion: StandingQuestion | null = null;
	let closeOfferMessageId: number | null = null;
	let replyQuestionMessageId: number | null = null;
	let replyQuestionGeneration = 0;
	let statusBlockUsed = false;
	let lastState = "";
	let lastHealth = "";
	let turnHealth = "";
	let lastSummary = "";
	let lastSummaryAt = 0;
	let badgeEmoji = "";
	let badgeOverride = "";
	let badgeChosen = false;
	const recentMessages: number[] = [];
	let lastNotifiedAt = 0;
	let turnActive = false;
	let sessionAlive = true;
	let typingSentAt = 0;
	/** Cleared when the turn carrying the answer ends: typing is chat-wide, so no session may hold it idly. */
	let replyOwed = false;
	let dashboardPublishedAt = 0;
	let approvalWaiting = false;
	let approvalNotice: ApprovalNotice | null = null;
	let pinnedMessageId: number | null = null;
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
	let turnStartedAt = 0;
	let turnEndedAt = 0;
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

	function parseSentRecord(parsed: unknown, id: number): SentRecord | null {
		if (parsed === null || typeof parsed !== "object") return null;
		const candidate = parsed as Partial<SentRecord>;
		const session = candidate.session as Partial<SentRecord["session"]> | undefined;
		if (
			candidate.version !== 1 ||
			candidate.id !== id ||
			typeof candidate.at !== "number" ||
			typeof candidate.kind !== "string" ||
			!Object.hasOwn(SENT_KINDS, candidate.kind) ||
			typeof candidate.text !== "string" ||
			session === undefined ||
			!isStateToken(session.id) ||
			typeof session.tag !== "string" ||
			typeof session.emoji !== "string" ||
			typeof session.name !== "string" ||
			typeof session.cwd !== "string"
		) {
			return null;
		}
		return candidate as SentRecord;
	}

	function readSentRecord(id: number): SentRecord | null {
		if (!isTelegramMessageId(id)) return null;
		try {
			return parseSentRecord(JSON.parse(readFileSync(join(SENT_DIR, `${id}.json`), "utf8")), id);
		} catch {
			return null;
		}
	}
	async function withSentRecordMarker<T>(work: (acceptEdit: () => void) => Promise<T>, messageId?: number): Promise<T> {
		mkdirSync(SENT_IN_FLIGHT_DIR, { recursive: true, mode: 0o700 });
		const prefix = messageId === undefined ? "new" : `edit-${messageId}`;
		const marker = join(SENT_IN_FLIGHT_DIR, `${prefix}-${randomUUID()}`);
		const previous = messageId === undefined ? null : readSentRecord(messageId);
		writeFileSync(marker, previous === null ? "" : JSON.stringify(previous), { mode: 0o600 });
		const heartbeat = setInterval(() => {
			try {
				const now = new Date();
				utimesSync(marker, now, now);
			} catch {}
		}, HEARTBEAT_MS);
		heartbeat.unref();
		let accepted = false;
		const acceptEdit = (): void => {
			if (messageId === undefined || accepted) return;
			writeFileAtomic(marker, "", 0o600);
			accepted = true;
		};
		try {
			return await work(acceptEdit);
		} finally {
			clearInterval(heartbeat);
			rmSync(marker, { force: true });
		}
	}

	function sentRecordInFlight(messageId: number, includeNew: boolean): boolean {
		if (!existsSync(SENT_IN_FLIGHT_DIR)) return false;
		let active = false;
		for (const entry of readdirSync(SENT_IN_FLIGHT_DIR)) {
			const marker = join(SENT_IN_FLIGHT_DIR, entry);
			try {
				if (Date.now() - statSync(marker).mtimeMs > SENT_MARKER_STALE_MS) unlinkSync(marker);
				else if ((includeNew && entry.startsWith("new-")) || entry.startsWith(`edit-${messageId}-`)) active = true;
			} catch {}
		}
		return active;
	}

	/** `undefined` means no edit, `null` means an accepted edit awaiting publication. */
	function recordBeforePendingEdit(messageId: number): SentRecord | null | undefined {
		if (!existsSync(SENT_IN_FLIGHT_DIR)) return;
		let previous: SentRecord | undefined;
		for (const entry of readdirSync(SENT_IN_FLIGHT_DIR)) {
			if (!entry.startsWith(`edit-${messageId}-`)) continue;
			const marker = join(SENT_IN_FLIGHT_DIR, entry);
			try {
				if (Date.now() - statSync(marker).mtimeMs > SENT_MARKER_STALE_MS) {
					unlinkSync(marker);
					continue;
				}
				const raw = readFileSync(marker, "utf8");
				if (raw.length === 0) return null;
				const candidate = parseSentRecord(JSON.parse(raw) as unknown, messageId);
				if (candidate === null) return null;
				if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(candidate)) return null;
				previous = candidate;
			} catch {
				return null;
			}
		}
		return previous;
	}

	function snapshotSentSession(): SentRecord["session"] {
		const name = badgeOverride.length > 0 ? badgeOverride : (sessionCtx?.sessionManager.getSessionName() ?? "");
		return { id: sessionId, tag: sessionTag, emoji: badgeEmoji, name, cwd: sessionCtx?.cwd ?? "" };
	}

	/** Persists what one Telegram message currently says so a later reaction can recover it. */
	function recordSent(
		id: number,
		kind: SentKind,
		text: string,
		sentSession: SentRecord["session"],
		payload?: unknown,
	): void {
		if (!isTelegramMessageId(id)) return;
		const record: SentRecord = {
			version: 1,
			id,
			at: Date.now(),
			kind,
			text,
			session: sentSession,
		};
		if (payload !== undefined) record.payload = payload;
		mkdirSync(SENT_DIR, { recursive: true, mode: 0o700 });
		writeFileAtomic(join(SENT_DIR, `${id}.json`), JSON.stringify(record), 0o600);
	}

	/** New messages become reply targets and reaction records atomically with the successful send. */
	function trackSent(
		sent: TelegramMessage | null,
		kind: SentKind,
		text: string,
		sentSession: SentRecord["session"],
		payload?: unknown,
		beforeRecord?: (messageId: number) => void,
	): void {
		if (!isTelegramMessageId(sent?.message_id)) return;
		recentMessages.push(sent.message_id);
		if (recentMessages.length > RECENT_MESSAGE_CAP) {
			recentMessages.splice(0, recentMessages.length - RECENT_MESSAGE_CAP);
		}
		beforeRecord?.(sent.message_id);
		if (sessionCtx !== null) writeSessionRecord(sessionCtx);
		recordSent(sent.message_id, kind, text, sentSession, payload);
	}

	/** Retries markup failures as plain text and records only messages with a non-null `kind`. */
	async function sendOrEdit(
		cfg: Config,
		method: "sendMessage" | "editMessageText",
		body: Record<string, unknown>,
		plain: string,
		keep = "",
		kind: SentKind | null = null,
		payload?: unknown,
		beforeRecord?: (messageId: number) => void,
		sentSession = snapshotSentSession(),
	): Promise<TelegramMessage | null> {
		const work = async (acceptEdit: () => void): Promise<TelegramMessage | null> => {
			const quiet = { link_preview_options: { is_disabled: true } };
			const source = fitToTelegram(plain, keep);
			let sentText = source;
			let refusal = "";
			let sent = await callTelegramRaw<TelegramMessage>(
				cfg,
				method,
				{ ...quiet, ...body, text: toTelegramHtml(source), parse_mode: "HTML" },
				15_000,
				(failure) => {
					refusal = failure.description;
				},
			);
			if (sent === null && isMarkupFailure(refusal)) {
				pi.logger.warn("telegram: rich send rejected, retrying as plain text", { method, description: refusal });
				const { message_effect_id: _effect, ...safe } = body;
				const fallback = plainStamps(source);
				sent = await callTelegram<TelegramMessage>(cfg, method, { ...quiet, ...safe, text: fallback }, 15_000);
				sentText = fallback;
			} else if (sent === null) {
				pi.logger.warn("telegram: send refused", { method, description: refusal });
			}
			if (sent !== null) {
				if (method === "editMessageText") acceptEdit();
				if (method === "sendMessage" && kind !== null) {
					trackSent(sent, kind, sentText, sentSession, payload, beforeRecord);
				} else if (method === "editMessageText" && isTelegramMessageId(body.message_id)) {
					const previous = readSentRecord(body.message_id);
					const editedKind = kind ?? previous?.kind;
					if (editedKind !== undefined) {
						beforeRecord?.(body.message_id);
						if (beforeRecord !== undefined && sessionCtx !== null) writeSessionRecord(sessionCtx);
						recordSent(body.message_id, editedKind, sentText, sentSession, payload ?? previous?.payload);
					}
				}
			}
			return sent;
		};
		if (method === "sendMessage" && kind !== null) return await withSentRecordMarker(work);
		const editedMessageId =
			method === "editMessageText" &&
			isTelegramMessageId(body.message_id) &&
			(kind !== null || readSentRecord(body.message_id) !== null)
				? body.message_id
				: undefined;
		return editedMessageId === undefined ? await work(() => {}) : await withSentRecordMarker(work, editedMessageId);
	}

	/** What this session is doing right now, in the words `/status` uses. */
	function sessionState(): string {
		if (pendingAsk !== null) return WAITING_ON_QUESTION;
		if (approvalWaiting) return "waiting on a tool approval";
		if (!turnActive) return "idle";
		return currentTool.length > 0 ? `working (${currentTool})` : "working";
	}

	function writeSessionRecord(ctx: ExtensionContext): void {
		lastState = sessionState();
		lastHealth = turnHealth;
		const record: SessionRecord = {
			pid: process.pid,
			tag: sessionTag,
			name: ctx.sessionManager.getSessionName() ?? "",
			cwd: ctx.cwd,
			emoji: badgeEmoji,
			emojiChosen: badgeChosen,
			label: badgeOverride,
			lastNotified: lastNotifiedAt,
			recent: [...recentMessages],
			question: pendingAsk?.messageId ?? null,
			replyQuestion: replyQuestionMessageId,
			standing: standingQuestion,
			closeOffer: closeOfferMessageId,
			pinned: pinnedMessageId,
			state: lastState,
			health: lastHealth,
			summary: lastSummary,
			summaryAt: lastSummaryAt,
			heartbeat: sessionAlive ? Date.now() : 0,
		};
		writeFileAtomic(join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(record), 0o600);
	}

	/** The record is the only thing another session can read, so anything it shows has to reach disk. */
	function noteState(): void {
		if (sessionCtx === null || (sessionState() === lastState && turnHealth === lastHealth)) return;
		writeSessionRecord(sessionCtx);
	}
	function closeReplyQuestion(target = replyQuestionMessageId): void {
		if (target !== replyQuestionMessageId) return;
		replyQuestionGeneration += 1;
		if (replyQuestionMessageId === null) return;
		replyQuestionMessageId = null;
		if (sessionCtx !== null) writeSessionRecord(sessionCtx);
	}

	/**
	 * A crippled cluster hits every session in the same turn, so provider trouble rides the record
	 * and the board draws it once instead of sending a message per session.
	 */
	function healthNote(text: string): void {
		turnHealth = text;
		noteState();
	}

	/**
	 * A record on disk was written by whatever code that session started with, and omp loads this
	 * extension from a working tree, so a fleet routinely mixes versions. Every field is therefore
	 * filled in here rather than asserted by a cast: one record missing `state` used to throw on
	 * every drain tick, which killed the board and the poll along with it.
	 */
	function readSessionRecord(id: string): SessionRecord | null {
		const path = join(SESSIONS_DIR, `${id}.json`);
		if (!existsSync(path)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			const raw = parsed as Partial<SessionRecord>;
			const text = (value: unknown): string => (typeof value === "string" ? value : "");
			const count = (value: unknown): number => (typeof value === "number" ? value : 0);
			const messageId = (value: unknown): number | null => (typeof value === "number" ? value : null);
			return {
				pid: count(raw.pid),
				tag: text(raw.tag),
				name: text(raw.name),
				cwd: text(raw.cwd),
				emoji: text(raw.emoji),
				emojiChosen: raw.emojiChosen === true,
				label: text(raw.label),
				lastNotified: count(raw.lastNotified),
				recent: Array.isArray(raw.recent) ? raw.recent.filter((m) => typeof m === "number") : [],
				question: messageId(raw.question),
				replyQuestion: messageId(raw.replyQuestion),
				standing: typeof raw.standing === "object" && raw.standing !== null ? raw.standing : null,
				closeOffer: messageId(raw.closeOffer),
				pinned: messageId(raw.pinned),
				state: text(raw.state),
				health: text(raw.health),
				summary: text(raw.summary),
				summaryAt: count(raw.summaryAt),
				heartbeat: count(raw.heartbeat),
			};
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

	/** Emoji in use by another live session, keyed to the badge that shows who holds each one. */
	function badgesInUse(): Map<string, SessionRecord> {
		const held = new Map<string, SessionRecord>();
		for (const record of otherLiveRecords()) {
			if (record.emoji.length > 0) held.set(record.emoji, record);
		}
		return held;
	}

	/**
	 * The palette is a courtesy for a session whose agent has not chosen yet, and a badge is only
	 * worth having while it is unique, so an exhausted palette yields nothing rather than a second
	 * copy of somebody else's emoji. Such a session shows no emoji until its agent picks one.
	 */
	function freeBadge(taken: Set<string>): string {
		return BADGE_PALETTE.find((candidate) => !taken.has(candidate)) ?? "";
	}

	/** The claim file verbatim: breaking one is only safe while it is byte-for-byte the one inspected. */
	function badgeClaimBytes(): string | null {
		try {
			return readFileSync(BADGE_LOCK_FILE, "utf8");
		} catch {
			return null;
		}
	}

	/** What a claim has to prove: who holds it, and when they took it. */
	function badgeClaimOf(raw: string): { token: string; heartbeat: number | null } | null {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== "object") return null;
			return {
				token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : "",
				heartbeat: "heartbeat" in parsed && typeof parsed.heartbeat === "number" ? parsed.heartbeat : null,
			};
		} catch {
			return null;
		}
	}

	/** The token of a won claim, or null when the claim is held elsewhere. */
	function takeBadgeClaim(): string | null {
		const token = randomUUID();
		try {
			writeFileSync(BADGE_LOCK_FILE, JSON.stringify({ sessionId, pid: process.pid, token, heartbeat: Date.now() }), {
				flag: "wx",
			});
			return token;
		} catch {}
		const raw = badgeClaimBytes();
		if (raw === null) return null;
		const beat = badgeClaimOf(raw)?.heartbeat ?? null;
		// The claim spans two file writes, so anything older than seconds died holding it. An
		// unreadable claim proves no liveness at all and must not wedge every badge behind it.
		if (beat !== null && Date.now() - beat < BADGE_CLAIM_STALE_MS) return null;
		// Break only the exact file just inspected: a claim written since then carries a fresh random
		// token, and deleting that one would hand two sessions the same emoji.
		if (badgeClaimBytes() === raw) {
			try {
				unlinkSync(BADGE_LOCK_FILE);
			} catch {}
		}
		return null;
	}

	/** Releasing somebody else's claim is what lets a third session in, so ownership is proved first. */
	function releaseBadgeClaim(token: string): boolean {
		const raw = badgeClaimBytes();
		if (raw === null || badgeClaimOf(raw)?.token !== token) return false;
		try {
			unlinkSync(BADGE_LOCK_FILE);
		} catch {}
		return true;
	}

	/**
	 * Claiming a badge reads every live record and then writes this one, and two sessions can
	 * interleave those halves into a shared emoji. An exclusive claim file closes that window:
	 * whoever holds it checks and persists alone, and a caller told the claim was unavailable
	 * retries rather than proceeding, because an unchecked write is the duplicate being prevented.
	 *
	 * No filesystem offers a delete conditional on content, so a claim broken as stale can in
	 * principle be one that a third process had just taken. That is why ownership is proved again
	 * after the work and `undo` puts the record back: a pass whose exclusivity did not hold leaves
	 * nothing behind, and the next attempt decides afresh.
	 */
	async function withBadgeClaim<T>(work: () => T, undo: () => void): Promise<{ ok: true; value: T } | { ok: false }> {
		for (let attempt = 0; attempt < 24; attempt++) {
			const token = takeBadgeClaim();
			if (token !== null) {
				let value: T;
				try {
					value = work();
				} catch (error) {
					releaseBadgeClaim(token);
					undo();
					throw error;
				}
				if (releaseBadgeClaim(token)) return { ok: true, value };
				undo();
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		undo();
		return { ok: false };
	}

	/** A session that lost the startup race for the claim shows no emoji until it wins one. */
	async function claimBadgeIfMissing(ctx: ExtensionContext): Promise<void> {
		let placed = false;
		const claimed = await withBadgeClaim(
			() => {
				// Waiting for the claim takes long enough for the agent to have chosen a badge, and a
				// chosen emoji outranks any placeholder this would put in its place.
				if (badgeEmoji.length > 0) return;
				badgeEmoji = freeBadge(new Set(badgesInUse().keys()));
				placed = badgeEmoji.length > 0;
				writeSessionRecord(ctx);
			},
			() => {
				if (!placed) return;
				placed = false;
				badgeEmoji = "";
				writeSessionRecord(ctx);
			},
		);
		if (!claimed.ok) pi.logger.warn("notify-telegram: badge claim still unavailable, this session shows no emoji");
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
			if (!isStateToken(id) || id === sessionId) continue;
			const record = readSessionRecord(id);
			// A live session refreshes its heartbeat every 15 seconds, so a stale one is gone.
			if (record !== null && Date.now() - record.heartbeat <= LOCK_STALE_MS) continue;
			mkdirSync(REACTION_ROUTE_LOCK_DIR, { recursive: true, mode: 0o700 });
			const closing = reactionRouteClosingFile(id);
			try {
				writeFileSync(closing, randomUUID(), { flag: "wx", mode: 0o600 });
			} catch {
				continue;
			}
			try {
				const queuedRedos = discardQueuedRedos(id);
				if (queuedRedos > 0) {
					detach(
						serviceNotice("Grade kept, but its session ended before the queued redo could reach the agent.", false),
						"dead-session redo notice",
					);
				}
				unlinkSync(join(SESSIONS_DIR, entry));
				rmSync(join(INBOX_DIR, id), { recursive: true, force: true });
				rmSync(reactionRouteLockFile(id), { force: true });
			} finally {
				rmSync(closing, { force: true });
			}
		}
	}

	let lastReap = 0;

	/** Downloaded files are working input, and sent messages are grading records. Neither is an archive. */
	function reapOldFiles(): void {
		if (Date.now() - lastReap < 3_600_000) return;
		lastReap = Date.now();
		for (const [dir, keepMs] of [
			[MEDIA_DIR, MEDIA_KEEP_MS],
			[SENT_DIR, SENT_KEEP_MS],
		] as const) {
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				try {
					if (Date.now() - statSync(path).mtimeMs > keepMs) unlinkSync(path);
				} catch {}
			}
		}
	}

	function badge(ctx: ExtensionContext): string {
		const detail = badgeOverride.length > 0 ? badgeOverride : (ctx.sessionManager.getSessionName() ?? "");
		return badgeLine(badgeEmoji, ctx.cwd, detail, sessionTag);
	}

	/** The same badge for a session this process does not own, rebuilt from its record. */
	function badgeOf(record: SessionRecord): string {
		return badgeLine(record.emoji, record.cwd, record.label.length > 0 ? record.label : record.name, record.tag);
	}
	function taskName(ctx: ExtensionContext): string {
		const named = badgeOverride.length > 0 ? badgeOverride : (ctx.sessionManager.getSessionName() ?? "");
		if (named.length > 0) return clip(named, 60);
		const folder =
			ctx.cwd
				.split("/")
				.filter((part) => part.length > 0)
				.pop() ?? ctx.cwd;
		return `${folder} [${sessionTag}]`;
	}

	/** The location shown in notifications, as `session:window.pane`. Re-read per message because windows move. */
	function tmuxLocation(): string | null {
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return null;
		try {
			const out = execFileSync(
				"tmux",
				["display-message", "-p", "-t", pane, "#{session_name}\t#{window_index}\t#{pane_index}"],
				{ timeout: 2000 },
			)
				.toString()
				.trim();
			const [session, index, paneIndex] = out.split("\t");
			if (session === undefined || index === undefined || index.length === 0) return null;
			return `${session}:${index}.${paneIndex ?? "0"}`;
		} catch {
			return null;
		}
	}

	/** Puts this session's pane in front for the user's return, but never while they are typing elsewhere.
	 * Selecting the window alone lands on whichever pane was last active there, so a co-located session would
	 * shadow this one; select-pane makes this session's own pane current inside that window. */
	function focusTmuxWindow(): void {
		if (config === null || Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return;
		try {
			execFileSync("tmux", ["select-window", "-t", pane, ";", "select-pane", "-t", pane], { timeout: 2000 });
		} catch {}
	}

	/** Offered on green summaries: everything is done, so the session may be shut down from the phone. */
	function closeSessionButton(): InlineButton {
		const label = process.env.TMUX === undefined ? "Close this session" : "Close this session and its tmux pane";
		return { text: label, callback_data: `k:${sessionTag}`, style: "danger" };
	}

	/** A detached shell outlives omp, so the pane dies only after the process has exited. Killing the pane, not
	 * the window, leaves any sibling sessions sharing that window untouched; a lone pane still takes its tab down. */
	function scheduleTmuxPaneKill(): void {
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX === undefined || pane === undefined) return;
		if (!/^%\d+$/u.test(pane)) return;
		try {
			spawn("sh", ["-c", `sleep 2; exec tmux kill-pane -t '${pane}'`], {
				detached: true,
				stdio: "ignore",
			}).unref();
		} catch {}
	}

	/** Drops every button from a message and leaves its text standing. */
	async function stripKeyboard(messageId: number): Promise<void> {
		if (config === null) return;
		await callTelegram(
			config,
			"editMessageReplyMarkup",
			{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
			10_000,
		);
	}

	/** The green-summary close button: strip the button, then let the ordinary shutdown path run. */
	async function closeSessionFromTelegram(messageId: number | undefined): Promise<void> {
		if (messageId !== undefined && closeOfferMessageId === messageId) closeOfferMessageId = null;
		if (typeof messageId === "number" && standingQuestion?.messageId !== messageId) {
			// A standing question is rewritten by session_shutdown; a plain summary only loses its button.
			await stripKeyboard(messageId);
		}
		scheduleTmuxPaneKill();
		sessionCtx?.shutdown();
	}

	/** The close offer dies the moment new work starts; a stale destructive button invites accidents. */
	function retireCloseOffer(withEdit: boolean): void {
		const messageId = closeOfferMessageId;
		if (messageId === null) return;
		closeOfferMessageId = null;
		if (sessionCtx !== null) writeSessionRecord(sessionCtx);
		if (!withEdit) return;
		detach(stripKeyboard(messageId), "close-offer retire");
	}

	/** One line per omp pane, read from the same pane titles that drive the tmux tabs. Listing panes, not windows,
	 * keeps sessions that share a window from collapsing into the window's single active-pane title. */
	function fleetReport(): string | null {
		if (process.env.TMUX === undefined) return null;
		let out: string;
		try {
			out = execFileSync(
				"tmux",
				[
					"list-panes",
					"-a",
					"-F",
					"#{session_name}\t#{window_index}\t#{window_bell_flag}\t#{@omp_priority}\t#{pane_title}",
				],
				{ timeout: 2000 },
			).toString();
		} catch {
			return null;
		}
		const parsed: { session: string; index: string; sep: string; bell: boolean; label: string; priority: boolean }[] =
			[];
		const ompPanesPerWindow = new Map<string, number>();
		for (const raw of out.split("\n")) {
			const parts = raw.split("\t");
			if (parts.length < 5) continue;
			const title = parts.slice(4).join("\t");
			if (!title.startsWith("\u03C0 ")) continue;
			const key = `${parts[0]}\t${parts[1]}`;
			ompPanesPerWindow.set(key, (ompPanesPerWindow.get(key) ?? 0) + 1);
			parsed.push({
				session: parts[0] ?? "",
				index: parts[1] ?? "",
				sep: title.slice(2, 3),
				bell: parts[2] === "1",
				label: title.slice(4),
				priority: parts[3] === "high",
			});
		}
		const rows: {
			session: string;
			index: string;
			state: keyof typeof counts;
			label: string;
			priority: boolean;
		}[] = [];
		const counts = { working: 0, waiting: 0, finished: 0, idle: 0 };
		for (const pane of parsed) {
			// window_bell_flag is a window property, so list-panes repeats it on every pane in the window.
			// Trust it as finished only where the window holds one omp pane, else the bell cannot name its session.
			const finished = pane.bell && ompPanesPerWindow.get(`${pane.session}\t${pane.index}`) === 1;
			const state =
				pane.sep === "!" ? "waiting" : SPINNER_FRAMES.has(pane.sep) ? "working" : finished ? "finished" : "idle";
			counts[state] += 1;
			rows.push({ session: pane.session, index: pane.index, state, label: pane.label, priority: pane.priority });
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
		// Whatever wants a human first, then what it can hand over, then what is still busy.
		const rank = { waiting: 0, finished: 1, working: 2, idle: 3 };
		const lines = rows
			.sort((a, b) => rank[a.state] - rank[b.state])
			.map((row) => {
				const mark = row.priority ? "\u2757 " : "";
				const where = manySessions ? `${row.session}:` : "";
				return `${glyphs[row.state]} ${mark}${where}${row.index} ${row.label}`;
			});
		return `\u{1F39B} ${summary}\n${lines.join("\n")}`;
	}

	/**
	 * The two lines every message from this session opens with: which session is speaking, then
	 * what it is working on, with which model, and where its terminal is. One shape everywhere, so
	 * a notification read on a phone never needs the terminal to be identified.
	 */
	function messageHead(ctx: ExtensionContext): string {
		return `${badge(ctx)}\n${sessionContextLine(ctx)}`;
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
						return tail;
					}
				}
			}
		} catch {}
		return "";
	}

	function withHead(ctx: ExtensionContext, title: string, body: string): string {
		return `${messageHead(ctx)}\n\n**${title}**\n${body}`;
	}

	/**
	 * A notice the session makes about itself is tracked, so replying to it routes back here. A
	 * poller-level refusal about someone else's message is not: replying to that would mean nothing.
	 */
	async function serviceNotice(text: string, routable = true): Promise<void> {
		if (config === null) return;
		await sendOrEdit(
			config,
			"sendMessage",
			{ chat_id: config.chatId },
			`\u{1F535} ${text}`,
			"",
			routable ? "notice" : null,
		);
	}

	async function sessionNotice(ctx: ExtensionContext, text: string): Promise<void> {
		await serviceNotice(`${messageHead(ctx)}\n\n${text}`);
	}

	/** Structured markdown (tables, fences) goes out as a native rich message; anything else keeps the HTML subset path. */
	async function sendStructured(
		cfg: Config,
		body: Record<string, unknown>,
		plain: string,
		keep: string,
		kind: SentKind,
		payload?: unknown,
		beforeRecord?: (messageId: number) => void,
	): Promise<TelegramMessage | null> {
		const sentSession = snapshotSentSession();
		if (/```|(^|\n)\|.+\|/.test(plain)) {
			const sent = await withSentRecordMarker(async () => {
				const accepted = await callTelegram<TelegramMessage>(
					cfg,
					"sendRichMessage",
					{ ...body, rich_message: { markdown: plain + keep } },
					15_000,
				);
				if (accepted !== null) trackSent(accepted, kind, plain + keep, sentSession, payload, beforeRecord);
				return accepted;
			});
			if (sent !== null) return sent;
		}
		return await sendOrEdit(cfg, "sendMessage", body, plain, keep, kind, payload, beforeRecord, sentSession);
	}

	/** `keep` is a short tail exempt from truncation, so an oversized body cannot swallow the usage footer. */
	async function notify(
		ctx: ExtensionContext,
		kind: SentKind,
		title: string,
		body: string,
		extra: Record<string, unknown> = {},
		keep = "",
		payload?: unknown,
		beforeRecord?: (messageId: number) => void,
	): Promise<TelegramMessage | null> {
		if (config === null) return null;
		const sent = await sendStructured(
			config,
			{ chat_id: config.chatId, ...extra },
			withHead(ctx, title, body),
			keep,
			kind,
			payload,
			beforeRecord,
		);
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

	/** One session's `/status` paragraph, built entirely from its record. */
	function statusLine(record: SessionRecord): string {
		const lines = [badgeOf(record), `State: ${record.state.length > 0 ? record.state : "unknown"}.`];
		if (record.health.length > 0) lines.push(`Provider: ${record.health}.`);
		if (record.summary.length > 0) lines.push(`Last: ${record.summary} (${relativeTime(record.summaryAt)})`);
		if (record.standing !== null) lines.push("A choice question stands open.");
		if (record.pinned !== null) lines.push("A red status is pinned.");
		return lines.join("\n");
	}

	/** Every live session in one message, busiest attention first. */
	function statusReport(): string {
		const live = allRecords()
			.filter(({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS)
			.sort((a, b) => b.record.lastNotified - a.record.lastNotified);
		if (live.length === 0) return "No live omp sessions.";
		return live.map(({ record }) => statusLine(record)).join("\n\n");
	}

	/**
	 * One compact line per session for the pinned board. The board is rewritten only when its text
	 * differs, so the stamp beside a summary is a client-rendered relative time rather than "4m ago"
	 * in the text, which would differ every minute and edit forever.
	 */
	function dashboardReport(): string {
		const live = allRecords()
			.filter(({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS)
			.sort((a, b) => b.record.lastNotified - a.record.lastNotified);
		if (live.length === 0) return "\u{1F39B} No live omp sessions.";
		const lines = live.map(({ record }) => {
			const state = record.state.length > 0 ? record.state : "unknown";
			const flags = [
				record.health,
				record.standing !== null ? "choice open" : "",
				record.pinned !== null ? "red pinned" : "",
			].filter((flag) => flag.length > 0);
			const tail = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
			const said = record.summary.length > 0 ? `\n    ${record.summary} (${relativeTime(record.summaryAt)})` : "";
			return `${badgeOf(record)} \u00B7 ${state}${tail}${said}`;
		});
		// Fitted here rather than at the send, so the text compared, recorded and sent are one
		// string: a board past the limit would otherwise differ every tick and never stop editing.
		return fitToTelegram(`\u{1F39B} Fleet\n${lines.join("\n")}`, "");
	}

	function readDashboard(): { messageId: number; text: string } | null {
		if (!existsSync(DASHBOARD_FILE)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(DASHBOARD_FILE, "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			const shown = parsed as { messageId?: unknown; text?: unknown };
			if (typeof shown.messageId !== "number" || typeof shown.text !== "string") return null;
			return { messageId: shown.messageId, text: shown.text };
		} catch {
			return null;
		}
	}

	/**
	 * The board has its own claim rather than riding the poller lock. omp loads this extension from
	 * a working tree, so a fleet routinely mixes code versions, and a session started before the
	 * board existed holds the poller lock for hours while being unable to draw one. Old code never
	 * claims this file, so ownership lands on a session that can actually publish. The message id
	 * lives in a shared file rather than a session record, so the next owner adopts the board.
	 */
	function claimsBoard(): boolean {
		if (ownsLock(DASHBOARD_LOCK_FILE)) {
			refreshLock(DASHBOARD_LOCK_FILE);
			return true;
		}
		return acquireLock(DASHBOARD_LOCK_FILE);
	}

	function maybeDashboard(): void {
		if (config === null || !config.pinnedDashboard || !claimsBoard()) return;
		if (Date.now() - dashboardPublishedAt < config.dashboardSeconds * 1000) return;
		let text: string;
		let shown: { messageId: number; text: string } | null;
		try {
			text = dashboardReport();
			shown = readDashboard();
		} catch (error) {
			// Keeping a claim we cannot draw strands the board for every other session, which is the
			// same failure as a lock holder that has no board code at all.
			releaseLock(DASHBOARD_LOCK_FILE);
			pi.logger.warn("notify-telegram: gave up the fleet board", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		// The rate limit is the scarce resource, and Telegram rejects an edit that changes nothing.
		if (shown !== null && shown.text === text) return;
		dashboardPublishedAt = Date.now();
		detach(publishDashboard(config, text, shown), "fleet dashboard");
	}

	/**
	 * A second board in the chat needs its own pin, and a pin comes back as an incoming message, so
	 * re-posting on a refusal that says nothing about the message having vanished is expensive and
	 * self-sustaining. Only Telegram naming a missing message earns a replacement.
	 */
	function boardVerdict(description: string): "gone" | "current" | "keep" {
		const said = description.toLowerCase();
		if (said.includes("not found") || said.includes("message_id_invalid")) return "gone";
		// The board already carries this text, which is what two publishers of one fleet collide on.
		if (said.includes("not modified")) return "current";
		return "keep";
	}

	async function publishDashboard(
		cfg: Config,
		text: string,
		shown: { messageId: number; text: string } | null,
	): Promise<void> {
		const rendered = {
			text: toTelegramHtml(text),
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		};
		const remember = (messageId: number): void =>
			writeFileAtomic(DASHBOARD_FILE, JSON.stringify({ messageId, text }), 0o600);
		if (shown !== null) {
			let refusal = "";
			const edited = await callTelegramRaw<TelegramMessage>(
				cfg,
				"editMessageText",
				{ chat_id: cfg.chatId, message_id: shown.messageId, ...rendered },
				10_000,
				(failure) => {
					refusal = failure.description;
				},
			);
			if (edited !== null) {
				remember(shown.messageId);
				return;
			}
			const verdict = boardVerdict(refusal);
			pi.logger.warn("notify-telegram: the fleet board edit was refused", { description: refusal, verdict });
			if (verdict === "current") {
				remember(shown.messageId);
				return;
			}
			// Keeping the board leaves the recorded text stale, which is what makes the next tick retry.
			if (verdict === "keep") return;
		}
		const sent = await callTelegram<TelegramMessage>(cfg, "sendMessage", { chat_id: cfg.chatId, ...rendered }, 15_000);
		if (typeof sent?.message_id !== "number") {
			pi.logger.warn("notify-telegram: the fleet board could not be posted", { chatId: cfg.chatId });
			return;
		}
		remember(sent.message_id);
		await callTelegram(
			cfg,
			"pinChatMessage",
			{ chat_id: cfg.chatId, message_id: sent.message_id, disable_notification: true },
			10_000,
		);
	}

	/** Typing is chat-wide but a turn is not, so only a session that owes the user an answer claims it. */
	function maybeType(): void {
		if (config === null || !turnActive || !replyOwed || pendingAsk !== null || approvalWaiting) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		if (Date.now() - draftSentAt < 10_000) return;
		if (Date.now() - typingSentAt < TYPING_MS) return;
		typingSentAt = Date.now();
		detach(
			callTelegram(config, "sendChatAction", { chat_id: config.chatId, action: "typing" }, 10_000),
			"typing action",
		);
	}

	/** Telegram's own upload status, for the seconds a file spends going up. */
	function showUploading(action: "upload_photo" | "upload_document"): void {
		if (config === null) return;
		detach(callTelegram(config, "sendChatAction", { chat_id: config.chatId, action }, 10_000), "upload action");
	}

	/** Streams the turn as an ephemeral draft bubble with a native stop control. */
	function maybeDraft(): void {
		if (config === null || !config.streamDrafts || config.chatId <= 0 || sessionCtx === null) return;
		if (!turnActive || pendingAsk !== null || approvalWaiting) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		if (!draftDirty || Date.now() - draftSentAt < DRAFT_MS) return;
		draftDirty = false;
		draftSentAt = Date.now();
		const context = messageHead(sessionCtx);
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
		const body = { chat_id: cfg.chatId, draft_id: draftId };
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
	function transparencyNotice(kind: string, text: string, ctx: ExtensionContext): void {
		if (config === null || noticedKinds.has(kind)) return;
		if (Date.now() - lastLocalInput < config.quietSeconds * 1000) return;
		noticedKinds.add(kind);
		detach(sessionNotice(ctx, text), "transparency notice");
	}

	/** Usage lines stay grouped by model, with the turn's tool count and wall time last. */
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
		const tail: string[] = [];
		if (turnTools > 0) tail.push(`${turnTools} ${turnTools === 1 ? "tool" : "tools"}`);
		// A stop with no `agent_end` behind it is still running as far as the clock is concerned.
		if (turnStartedAt > 0) {
			tail.push(duration((turnEndedAt > turnStartedAt ? turnEndedAt : Date.now()) - turnStartedAt));
		}
		if (tail.length > 0) lines.push(`\`${tail.join(" \u00B7 ")}\``);
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

	/**
	 * Green gets the celebration effect; red gets pinned by the caller. A turn ending while the
	 * user is typing at the terminal still lands, without a sound and without the confetti.
	 */
	function urgencyExtras(urgency: TurnStatus["urgency"], quiet: boolean): Record<string, unknown> {
		if (quiet) return { disable_notification: true };
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

	/** One poller only, or Telegram 409s. Atomic `wx` create; ownership re-read, never cached. */
	function readLock(file: string = LOCK_FILE): { sessionId: string; pid: number; heartbeat: number } | null {
		if (!existsSync(file)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			const raw = parsed as { sessionId?: unknown; pid?: unknown; heartbeat?: unknown };
			if (typeof raw.sessionId !== "string" || typeof raw.heartbeat !== "number") return null;
			return { sessionId: raw.sessionId, pid: typeof raw.pid === "number" ? raw.pid : 0, heartbeat: raw.heartbeat };
		} catch {
			return null;
		}
	}

	function acquireLock(file: string = LOCK_FILE): boolean {
		const mine = JSON.stringify({ sessionId, pid: process.pid, heartbeat: Date.now() });
		try {
			writeFileSync(file, mine, { flag: "wx" });
		} catch {
			const held = readLock(file);
			if (held !== null && Date.now() - held.heartbeat < LOCK_STALE_MS) return false;
			try {
				unlinkSync(file);
			} catch {}
			try {
				writeFileSync(file, mine, { flag: "wx" });
			} catch {
				return false;
			}
		}
		return readLock(file)?.sessionId === sessionId;
	}

	function ownsLock(file: string = LOCK_FILE): boolean {
		return readLock(file)?.sessionId === sessionId;
	}

	function refreshLock(file: string = LOCK_FILE): void {
		if (!ownsLock(file)) return;
		writeFileAtomic(file, JSON.stringify({ sessionId, pid: process.pid, heartbeat: Date.now() }));
	}

	function releaseLock(file: string = LOCK_FILE): void {
		if (!ownsLock(file)) return;
		try {
			unlinkSync(file);
		} catch {}
	}

	/** Replied-to message, then recency. Unresolvable targets are refused, not guessed. */
	function routeMessage(replyTo: number | undefined): string | null {
		const live = allRecords().filter(({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS);
		if (replyTo !== undefined) {
			return live.find(({ record }) => record.recent?.includes(replyTo) === true)?.id ?? null;
		}
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

	/**
	 * Bot API refuses getFile beyond 20 MB; larger uploads get a notice instead of silence. Every
	 * abandoned path logs its own reason: the user-facing notice is necessarily generic, so without
	 * this a lost file leaves nothing to diagnose.
	 */
	async function downloadMedia(
		cfg: Config,
		media: IncomingFile,
		updateId: number,
		owner: string,
	): Promise<string | null> {
		const give = (reason: string, meta: Record<string, unknown> = {}): null => {
			pi.logger.warn(`notify-telegram: media ${reason}`, { fileId: media.fileId, updateId, ...meta });
			return null;
		};
		if (media.size !== undefined && media.size > MEDIA_MAX_BYTES) {
			return give("oversized before download", { size: media.size, ceiling: MEDIA_MAX_BYTES });
		}
		const file = await callTelegram<{ file_path?: string }>(cfg, "getFile", { file_id: media.fileId }, 30_000);
		const remote = file?.file_path;
		if (typeof remote !== "string" || remote.length === 0) return give("no file path from getFile");
		// A thrown fetch here must not escape: pollOnce would never advance the update
		// offset, refetching the batch and re-delivering its earlier updates forever.
		let bytes: Uint8Array;
		try {
			const response = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${remote}`, {
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) return give("download rejected", { status: response.status });
			bytes = new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			return give("download failed", { error: error instanceof Error ? error.message : String(error) });
		}
		if (bytes.byteLength > MEDIA_MAX_BYTES) {
			return give("oversized after download", { bytes: bytes.byteLength, ceiling: MEDIA_MAX_BYTES });
		}
		const original = (media.name ?? remote).split("/").at(-1) ?? "file";
		mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
		const path = join(MEDIA_DIR, standardFileName({ at: Date.now(), kind: media.kind, owner, updateId, original }));
		writeFileSync(path, bytes, { mode: 0o600 });
		return path;
	}

	/**
	 * Live sessions whose last notification is within a minute of the most recent one. Two turns
	 * finishing together is the only case where a plain message genuinely could belong to either.
	 */
	function ambiguousTargets(): Array<{ id: string; record: SessionRecord }> {
		const live = allRecords().filter(
			({ record }) => Date.now() - record.heartbeat <= LOCK_STALE_MS && record.lastNotified > 0,
		);
		let newest = 0;
		for (const { record } of live) newest = Math.max(newest, record.lastNotified);
		return live.filter(({ record }) => newest - record.lastNotified <= AMBIGUOUS_WINDOW_MS);
	}

	function heldMessagePath(updateId: string): string {
		return join(PENDING_MESSAGES_DIR, `${updateId}.json`);
	}

	/** The held entry is the exact inbox entry the tap delivers, so a command survives the hold unchanged. */
	function readHeldMessage(updateId: string): InboxEntry | null {
		if (!/^\d+$/u.test(updateId) || !existsSync(heldMessagePath(updateId))) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(heldMessagePath(updateId), "utf8"));
			if (parsed === null || typeof parsed !== "object") return null;
			const held = parsed as Partial<InboxEntry>;
			if (held.kind !== "text" && held.kind !== "command") return null;
			if (typeof held.value !== "string" || held.value.length === 0) return null;
			return {
				kind: held.kind,
				value: held.value,
				...(typeof held.messageId === "number" ? { messageId: held.messageId } : {}),
			};
		} catch {
			return null;
		}
	}

	/** A picker nobody ever tapped leaves the message on disk; it is stale long before this. */
	function reapHeldMessages(): void {
		if (!existsSync(PENDING_MESSAGES_DIR)) return;
		for (const entry of readdirSync(PENDING_MESSAGES_DIR)) {
			try {
				const path = join(PENDING_MESSAGES_DIR, entry);
				if (Date.now() - statSync(path).mtimeMs > HELD_MESSAGE_TTL_MS) unlinkSync(path);
			} catch {}
		}
	}

	/** Holds the entry and asks, rather than guessing and landing it in the wrong session. */
	async function askWhichSession(
		cfg: Config,
		update: TelegramUpdate,
		entry: InboxEntry,
		header: string,
		rivals: Array<{ id: string; record: SessionRecord }>,
	): Promise<void> {
		mkdirSync(PENDING_MESSAGES_DIR, { recursive: true, mode: 0o700 });
		writeFileAtomic(heldMessagePath(String(update.update_id)), JSON.stringify(entry), 0o600);
		// One block per rival and a whole fleet can be rivals, so the list can outgrow one message.
		// It is cut by whole entries and the keyboard is built from the same ones: a shortened list
		// beside a full keyboard would offer a choice the reader cannot see.
		const note = (count: number): string => `\n\n(${count} not listed. Reply to a message from the session you mean.)`;
		const whole = [header, ...rivals.map(({ record }) => statusLine(record))].join("\n\n");
		let listed = rivals;
		let body = whole;
		// Room for the note is reserved only once something must actually be omitted. Reserving it
		// unconditionally costs the last session its place, and its button, to a note nobody needs.
		if (whole.length > TELEGRAM_TEXT_MAX) {
			const worst = note(rivals.length);
			listed = [];
			body = header;
			for (const rival of rivals) {
				const grown = `${body}\n\n${statusLine(rival.record)}`;
				if ((grown + worst).length > TELEGRAM_TEXT_MAX) break;
				body = grown;
				listed.push(rival);
			}
			// A picker with no options is no use, so one entry survives even if it has to be truncated.
			const first = rivals[0];
			if (listed.length === 0 && first !== undefined) {
				listed = [first];
				body = `${header}\n\n${statusLine(first.record)}`;
			}
		}
		const omitted = rivals.length - listed.length;
		await callTelegram(
			cfg,
			"sendMessage",
			{
				chat_id: cfg.chatId,
				text: toTelegramHtml(fitToTelegram(omitted > 0 ? body + note(omitted) : body, "")),
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				reply_markup: {
					inline_keyboard: packRows(
						listed.map(({ record }) => ({
							text: buttonText(badgeOf(record)),
							callback_data: `m:${update.update_id}:${record.tag}`,
						})),
					),
				},
			},
			15_000,
		);
	}

	/** A press on the picker delivers the held entry to the chosen session. */
	async function deliverHeldMessage(cfg: Config, callback: TelegramCallbackQuery): Promise<void> {
		const [, rawUpdate = "", tag = ""] = (callback.data ?? "").split(":");
		const held = readHeldMessage(rawUpdate);
		const owner = allRecords().find(
			({ record }) => record.tag === tag && Date.now() - record.heartbeat <= LOCK_STALE_MS,
		);
		const gone = held === null || owner === undefined;
		const stopping = held?.kind === "command";
		await callTelegram(
			cfg,
			"answerCallbackQuery",
			{
				callback_query_id: callback.id,
				text: gone ? "That message is no longer waiting." : stopping ? "Stopping it." : "Sending it there.",
			},
			10_000,
		);
		const closing = gone
			? "\u{1F535} That message is no longer waiting."
			: `\u{1F535} ${stopping ? "Stopping" : "Sent to"} ${badgeOf(owner.record)}.`;
		if (!gone) {
			deliver(owner.id, Number.parseInt(rawUpdate, 10), held);
			try {
				unlinkSync(heldMessagePath(rawUpdate));
			} catch {}
		}
		if (typeof callback.message?.message_id !== "number") return;
		await callTelegram(
			cfg,
			"editMessageText",
			{
				chat_id: cfg.chatId,
				message_id: callback.message.message_id,
				text: toTelegramHtml(closing),
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: [] },
			},
			10_000,
		);
	}

	/**
	 * A question asked by something that is not an omp session, its buttons carrying `e:<key>:<choice>`.
	 * The poller holds the only getUpdates consumer, so it is the only thing that can observe the press;
	 * it records the choice to a file the asker polls, then greys the buttons. Sending such a question
	 * is not a scarce operation and stays with the asker, which is why this channel has no send half.
	 */
	async function answerExternalQuestion(cfg: Config, callback: TelegramCallbackQuery): Promise<void> {
		const data = callback.data ?? "";
		// The key holds no colon, so the choice keeps everything after the second one intact.
		const keyEnd = data.indexOf(":", 2);
		const key = keyEnd === -1 ? "" : data.slice(2, keyEnd);
		const choice = keyEnd === -1 ? "" : data.slice(keyEnd + 1);
		const valid = EXTERNAL_KEY.test(key) && choice.length > 0;
		// A destructive asker must act on a single answer, so the first valid press for a key wins:
		// later presses in the same batch only re-acknowledge, never overwrite or re-settle.
		const fresh = valid && !externalAnswered.has(key);
		if (fresh) {
			externalAnswered.add(key);
			// The asker created this directory to receive the answer. Recorded before the toast,
			// which then reports a delivery this write has already made.
			writeFileAtomic(join(EXTERNAL_ANSWERS_DIR, `${key}.json`), JSON.stringify({ choice, at: Date.now() }), 0o600);
		} else if (!valid) {
			pi.logger.warn("telegram: rejected an external answer with a malformed key or choice", {
				data: clip(data, 80),
			});
		}
		await callTelegram(
			cfg,
			"answerCallbackQuery",
			{
				callback_query_id: callback.id,
				text: valid ? (fresh ? "Recorded." : "Already recorded.") : "That button is malformed.",
			},
			10_000,
		);
		const message = callback.message;
		if (!fresh || message === undefined) return;
		// Only the keyboard is edited, so the question's own text and formatting survive untouched.
		const settled = (message.reply_markup?.inline_keyboard ?? []).map((row) =>
			row.map((button) => ({
				text: buttonText(`${button.callback_data === callback.data ? "\u2713 " : ""}${button.text}`),
				callback_data: SETTLED_CALLBACK,
				disabled: {},
			})),
		);
		if (settled.length === 0) return;
		await callTelegram(
			cfg,
			"editMessageReplyMarkup",
			{ chat_id: cfg.chatId, message_id: message.message_id, reply_markup: { inline_keyboard: settled } },
			10_000,
		);
	}

	function isStatusQuestion(record: SentRecord): boolean {
		return (
			record.kind === "status" &&
			record.payload !== null &&
			typeof record.payload === "object" &&
			typeof (record.payload as Partial<TurnStatus>).question === "string"
		);
	}

	/** Builds the correction prompt used as either an ask answer or a steer. */
	function redoNote(record: SentRecord, emoji: string[]): string {
		const opening = `The user reacted ${emoji.join(" ")} on Telegram to`;
		const body = record.text.split("\n\n").slice(1).join("\n\n") || record.text;
		const quoted = `\n\n> ${clip(body, PREVIEW_MAX).replaceAll("\n", "\n> ")}`;
		const statusQuestion = isStatusQuestion(record);
		if (record.kind === "question" || record.kind === "standing" || statusQuestion) {
			const viaStatus = record.kind === "question" ? "" : " through notify_status";
			return `${opening} your question, which did not make sense on the phone: restate it with the context and definitions a reader who cannot see the terminal needs, spelling out every term this session introduced, then ask again${viaStatus}.${quoted}`;
		}
		switch (record.kind) {
			case "snippet":
				return `${opening} the snippet you sent, which did not make sense on the phone: send it again with notify_snippet, with a purpose line that says what the text is for and where it goes.${quoted}`;
			case "file":
				return `${opening} the file you sent, which did not make sense on the phone: send it again with notify_file, with a caption that says what it shows and why it matters.${quoted}`;
			default:
				return `${opening} your turn-end status, which did not stand on its own: write it again with notify_status, stating what changed, what is open, and what you need while assuming this message is all the reader sees.${quoted}`;
		}
	}

	function feedbackHasUpdate(updateId: number): boolean {
		let raw = "";
		try {
			raw = readFileSync(FEEDBACK_FILE, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		for (const row of raw.split("\n")) {
			if (row.length === 0) continue;
			try {
				const candidate = JSON.parse(row) as { updateId?: unknown };
				if (candidate.updateId === updateId) return true;
			} catch {}
		}
		return false;
	}

	function reactionTransactionFile(updateId: number): string {
		return join(REACTION_PENDING_DIR, `${updateId}.json`);
	}

	function readReactionTransaction(updateId: number): ReactionTransaction | null {
		try {
			const parsed = JSON.parse(
				readFileSync(reactionTransactionFile(updateId), "utf8"),
			) as Partial<ReactionTransaction>;
			if (
				parsed.transaction !== 1 ||
				parsed.updateId !== updateId ||
				parsed.feedback === null ||
				typeof parsed.feedback !== "object"
			) {
				return null;
			}
			if (
				parsed.kind === "redo" &&
				(typeof parsed.value !== "string" ||
					!isTelegramMessageId(parsed.messageId) ||
					typeof parsed.targetKind !== "string")
			) {
				return null;
			}
			return parsed as ReactionTransaction;
		} catch {
			return null;
		}
	}

	function reactionTransactionTarget(transaction: ReactionTransaction): string | null {
		if (!("message" in transaction.feedback)) return null;
		const message = transaction.feedback.message;
		if (message === null || typeof message !== "object" || !("session" in message)) return null;
		const session = message.session;
		if (session === null || typeof session !== "object" || !("id" in session)) return null;
		return isStateToken(session.id) ? session.id : null;
	}

	function reactionRouteLockFile(target: string): string {
		return join(REACTION_ROUTE_LOCK_DIR, `${target}.lock`);
	}

	function reactionRouteClosingFile(target: string): string {
		return join(REACTION_ROUTE_LOCK_DIR, `${target}.closing`);
	}

	function releaseReactionRouteLock(target: string, token: string): void {
		const path = reactionRouteLockFile(target);
		try {
			if (readFileSync(path, "utf8") === token) unlinkSync(path);
		} catch {}
	}

	function takeReactionRouteLock(target: string, duringShutdown = false): string | null {
		mkdirSync(REACTION_ROUTE_LOCK_DIR, { recursive: true, mode: 0o700 });
		const closing = reactionRouteClosingFile(target);
		if (!duringShutdown && existsSync(closing)) return null;
		const path = reactionRouteLockFile(target);
		const token = randomUUID();
		try {
			writeFileSync(path, token, { flag: "wx", mode: 0o600 });
		} catch {
			return null;
		}
		if (!duringShutdown && existsSync(closing)) {
			releaseReactionRouteLock(target, token);
			return null;
		}
		return token;
	}

	function resetReactionRouteForStartup(target: string): void {
		mkdirSync(REACTION_ROUTE_LOCK_DIR, { recursive: true, mode: 0o700 });
		const closing = reactionRouteClosingFile(target);
		rmSync(closing, { force: true });
		writeFileSync(closing, randomUUID(), { flag: "wx", mode: 0o600 });
		try {
			rmSync(reactionRouteLockFile(target), { force: true });
		} finally {
			rmSync(closing, { force: true });
		}
	}

	function ownsOpenReactionRoute(target: string, token: string): boolean {
		if (existsSync(reactionRouteClosingFile(target))) return false;
		try {
			return readFileSync(reactionRouteLockFile(target), "utf8") === token;
		} catch {
			return false;
		}
	}

	function commitReactionTransaction(transaction: ReactionTransaction): boolean {
		if (transaction.kind === "redo") {
			const target = reactionTransactionTarget(transaction);
			if (target === null) throw new Error("Unsafe reaction inbox target");
			const token = takeReactionRouteLock(target);
			if (token === null) throw new Error("Reaction inbox route is busy");
			try {
				const owner = readSessionRecord(target);
				const liveOwner = owner !== null && Date.now() - owner.heartbeat <= LOCK_STALE_MS;
				if (!ownsOpenReactionRoute(target, token)) throw new Error("Reaction inbox route is closing");
				const alreadyRecorded = feedbackHasUpdate(transaction.updateId);
				if (!liveOwner) {
					if (!alreadyRecorded) {
						transaction.feedback.redo = false;
						appendFileSync(FEEDBACK_FILE, `${JSON.stringify(transaction.feedback)}\n`, { mode: 0o600 });
					}
					rmSync(reactionTransactionFile(transaction.updateId), { force: true });
					return false;
				}
				if (!alreadyRecorded) {
					if (!ownsOpenReactionRoute(target, token)) throw new Error("Reaction inbox route is closing");
					appendFileSync(FEEDBACK_FILE, `${JSON.stringify(transaction.feedback)}\n`, { mode: 0o600 });
					if (!ownsOpenReactionRoute(target, token)) throw new Error("Reaction inbox route closed during commit");
				}
				const pending = reactionTransactionFile(transaction.updateId);
				const dir = join(INBOX_DIR, target);
				const inbox = join(dir, `${transaction.updateId}.json`);
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				if (!ownsOpenReactionRoute(target, token)) throw new Error("Reaction inbox route is closing");
				renameSync(pending, inbox);
				if (!ownsOpenReactionRoute(target, token)) {
					try {
						renameSync(inbox, pending);
					} catch {}
					throw new Error("Reaction inbox route closed during publication");
				}
				return true;
			} finally {
				releaseReactionRouteLock(target, token);
			}
		}
		if (!feedbackHasUpdate(transaction.updateId)) {
			appendFileSync(FEEDBACK_FILE, `${JSON.stringify(transaction.feedback)}\n`, { mode: 0o600 });
		}
		rmSync(reactionTransactionFile(transaction.updateId), { force: true });
		return true;
	}

	/** Records each reaction change and requests a rewrite for strongly negative grades on agent messages. */
	async function handleReaction(cfg: Config, updateId: number, reaction: TelegramReaction): Promise<false | undefined> {
		if (reaction.chat.id !== cfg.chatId || reaction.user?.id !== cfg.chatId) {
			pi.logger.warn("telegram: rejected a reaction from an unexpected origin", {
				chat: reaction.chat.id,
				from: reaction.user?.id,
			});
			return;
		}
		if (!isTelegramMessageId(updateId)) {
			pi.logger.warn("telegram: rejected a reaction with an invalid update id", { id: updateId });
			return;
		}
		if (!isTelegramMessageId(reaction.message_id)) {
			pi.logger.warn("telegram: rejected a reaction with an invalid message id", { id: reaction.message_id });
			return;
		}
		const pending = readReactionTransaction(updateId);
		if (pending !== null) {
			try {
				if (!commitReactionTransaction(pending)) {
					await serviceNotice(
						"Grade kept, but that session ended before its queued redo could reach the agent.",
						false,
					);
				}
			} catch (error) {
				pi.logger.warn("telegram: could not finish a reaction transaction", {
					update: updateId,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			return;
		}
		const beforeEdit = recordBeforePendingEdit(reaction.message_id);
		if (beforeEdit === null) return false;
		let record = beforeEdit === undefined ? readSentRecord(reaction.message_id) : beforeEdit;
		if (beforeEdit === undefined && sentRecordInFlight(reaction.message_id, record === null)) return false;
		if (beforeEdit === undefined) record = readSentRecord(reaction.message_id) ?? record;
		if (record === null) {
			await serviceNotice(
				`Reaction error: that message is not on record, so the reaction was not kept; session messages stay gradable for ${SENT_KEEP_MS / 86_400_000} days.`,
				false,
			);
			return;
		}
		try {
			if (feedbackHasUpdate(updateId)) return;
		} catch (error) {
			pi.logger.warn("telegram: could not read reaction history", {
				update: updateId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		const emoji = reaction.new_reaction.map((item) =>
			item.type === "emoji" ? item.emoji : item.type === "paid" ? "paid" : `custom:${item.custom_emoji_id}`,
		);
		let grade: number | null = null;
		const ungraded: string[] = [];
		for (const token of emoji) {
			const value = REACTION_GRADES[token.replaceAll("\uFE0F", "")];
			if (value === undefined) ungraded.push(token);
			else grade = grade === null ? value : Math.min(grade, value);
		}
		if (ungraded.length > 0) grade = null;
		const agentWrote = record.kind !== "notice" && record.kind !== "approval";
		const wantsRedo = grade !== null && grade <= REDO_GRADE;
		const owner = wantsRedo && agentWrote ? readSessionRecord(record.session.id) : null;
		const liveOwner = owner !== null && Date.now() - owner.heartbeat <= LOCK_STALE_MS;
		const statusQuestion = isStatusQuestion(record);
		const targetOpen =
			record.kind === "question"
				? owner?.question === record.id
				: record.kind === "standing"
					? owner?.standing?.messageId === record.id
					: statusQuestion
						? owner?.replyQuestion === record.id
						: true;
		const redo = liveOwner && targetOpen;
		const line = {
			version: 1,
			updateId,
			at: reaction.date * 1000,
			messageId: reaction.message_id,
			emoji,
			previous: reaction.old_reaction.map((item) =>
				item.type === "emoji" ? item.emoji : item.type === "paid" ? "paid" : `custom:${item.custom_emoji_id}`,
			),
			grade,
			redo,
			message: record,
		};
		const redoEntry: InboxEntry | undefined = redo
			? {
					kind: "redo",
					value: redoNote(record, emoji),
					messageId: record.id,
					targetKind: record.kind,
					targetQuestion: statusQuestion,
					targetPreEdit: beforeEdit !== undefined,
				}
			: undefined;
		const transaction: ReactionTransaction = {
			transaction: 1,
			updateId,
			feedback: line,
			...redoEntry,
		};
		let redoRouted = true;
		try {
			mkdirSync(REACTION_PENDING_DIR, { recursive: true, mode: 0o700 });
			writeFileAtomic(reactionTransactionFile(updateId), JSON.stringify(transaction), 0o600);
			redoRouted = commitReactionTransaction(transaction);
		} catch (error) {
			pi.logger.warn("telegram: could not commit a reaction transaction", {
				update: updateId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		if (ungraded.length > 0) {
			const scale = REACTION_SCALE.map(([g, set]) => `${g > 0 ? "+" : ""}${g} ${set.join("")}`).join(" \u00B7 ");
			await serviceNotice(
				`Reaction error: ${ungraded.join(" ")} is outside the grading scale, so it was kept without a grade; graded reactions: ${scale}.`,
				false,
			);
		}
		if (redo && !redoRouted) {
			await serviceNotice("Grade kept, but that session ended before its queued redo could reach the agent.", false);
		}
		if (wantsRedo && !redo) {
			const reason =
				agentWrote && liveOwner && !targetOpen
					? "Grade kept, but that question is already closed, so it was not reopened."
					: agentWrote
						? "Grade kept, but that session is gone, so nothing was redone."
						: "Grade kept, but those were this bot's own words, so there is nothing to redo.";
			await serviceNotice(reason, false);
		}
	}

	async function handleUpdate(cfg: Config, update: TelegramUpdate): Promise<false | undefined> {
		const callback = update.callback_query;
		if (update.message_reaction !== undefined) {
			return await handleReaction(cfg, update.update_id, update.message_reaction);
		}
		if (callback !== undefined && callback.data !== undefined) {
			if (callback.message?.chat.id !== cfg.chatId || callback.from?.id !== cfg.chatId) {
				pi.logger.warn("telegram: rejected a button press from an unexpected origin", {
					chat: callback.message?.chat.id,
					from: callback.from?.id,
				});
				return;
			}
			if (callback.data.startsWith("m:")) {
				await deliverHeldMessage(cfg, callback);
				return;
			}
			if (callback.data.startsWith("e:")) {
				await answerExternalQuestion(cfg, callback);
				return;
			}
			// A press on a settled question's dead buttons is not a routing failure, and saying the
			// session is gone claims something alarming and untrue.
			if (callback.data === SETTLED_CALLBACK) {
				await callTelegram(
					cfg,
					"answerCallbackQuery",
					{ callback_query_id: callback.id, text: "That question is already answered." },
					10_000,
				);
				return;
			}
			const owner = routeByAskId(callback.data.split(":")[1] ?? "");
			// Delivered first: every wording below describes work already done, and a toast must not
			// promise a delivery the write that follows it could still fail to make.
			if (owner !== null) {
				deliver(owner, update.update_id, {
					kind: "callback",
					value: callback.data,
					messageId: callback.message?.message_id,
				});
			}
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
									: // Whether the press still fits the open question is decided in the session, which
										// discards a tap the ask has moved past. The poller reports only what it did.
										"Sent to that session.",
				},
				10_000,
			);
			return;
		}

		const message = update.message;
		if (message === undefined) return;
		if (message.chat.id !== cfg.chatId) {
			pi.logger.warn("telegram: rejected a message from an unexpected chat", { chat: message.chat.id });
			return;
		}
		if (isChatEvent(message)) return;
		const replyTo = message.reply_to_message?.message_id;
		const text = message.text ?? message.caption;

		const command =
			typeof text === "string" ? /^\/(hidequestions|status|fleet|stop)\b/u.exec(text.trim())?.[1] : undefined;
		if (command === "fleet") {
			// Sent directly rather than through sendOrEdit: a fleet listing is not a session message
			// and must stay out of the reply-routing history.
			const report = fitToTelegram(fleetReport() ?? "\u{1F535} No tmux server is reachable from this process.", "");
			await callTelegram(
				cfg,
				"sendMessage",
				{
					chat_id: cfg.chatId,
					text: toTelegramHtml(report),
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				},
				15_000,
			);
			return;
		}
		if (command === "stop") {
			// Aborting the wrong turn is worse than guessing: a reply names its target outright, a
			// bare /stop goes to the one session mid-turn, and with several the user picks. A session
			// on its first turn may have sent nothing replyable yet, so a picker is the only way in.
			if (replyTo !== undefined) {
				const target = routeMessage(replyTo);
				if (target === null) {
					await serviceNotice("No live omp session owns that message, so nothing was stopped.", false);
					return;
				}
				deliver(target, update.update_id, { kind: "command", value: command });
				return;
			}
			const running = allRecords().filter(
				({ record }) =>
					Date.now() - record.heartbeat <= LOCK_STALE_MS && record.state.length > 0 && record.state !== "idle",
			);
			if (running.length === 0) {
				await serviceNotice("No turn is running.", false);
				return;
			}
			if (running.length === 1 && running[0] !== undefined) {
				deliver(running[0].id, update.update_id, { kind: "command", value: command });
				return;
			}
			await askWhichSession(
				cfg,
				update,
				{ kind: "command", value: command },
				`\u{1F535} ${running.length} sessions are running a turn. Which one should stop?`,
				running,
			);
			return;
		}
		if (command !== undefined) {
			// `/status` answers for the whole fleet from the records, so exactly one session composes it.
			const targets =
				command === "status"
					? [routeMessage(undefined)].filter((id): id is string => id !== null)
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
			const target = routeMessage(replyTo);
			if (target === null) {
				await serviceNotice("No live omp session owns that message, so it was dropped.", false);
				return;
			}
			const record = readSessionRecord(target);
			const owner = record === null ? "unknown" : fileOwner(record.tag, record.emoji);
			const saved = await downloadMedia(cfg, media, update.update_id, owner);
			if (saved === null) {
				await serviceNotice("That file could not be fetched (20 MB is the ceiling), so it was dropped.", false);
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
				false,
			);
			return;
		}

		const target = routeMessage(replyTo);
		if (target === null) {
			await serviceNotice(
				"No live omp session owns that message, so it was dropped. Reply to a message from the session you mean.",
				false,
			);
			return;
		}
		// A plain message with no reply attached is the only one that can be misrouted, and only
		// when two sessions finished together. Ask instead of guessing.
		let routed = target;
		if (replyTo === undefined) {
			const rivals = ambiguousTargets();
			if (rivals.length > 1) {
				// An open question outranks recency: a bare message plainly answers it.
				const asking = rivals.filter(({ record }) => record.state === WAITING_ON_QUESTION);
				if (asking.length !== 1 || asking[0] === undefined) {
					await askWhichSession(
						cfg,
						update,
						{ kind: "text", value: text, messageId: message.message_id },
						`\u{1F535} ${rivals.length} sessions finished within a minute of each other, so I did not guess. Which one did you mean?`,
						rivals,
					);
					return;
				}
				routed = asking[0].id;
			}
		}
		deliver(routed, update.update_id, {
			kind: "text",
			value: text,
			messageId: message.message_id,
			replyTo,
		});
	}

	/**
	 * Settings get edited by hand while sessions run, so a change has to land without a restart.
	 * The offset is the exception: it advances in memory long before it reaches disk, and adopting
	 * a lower value would refetch updates this session has already delivered.
	 */
	function reloadConfig(): void {
		if (config === null) return;
		const fresh = loadConfig();
		// A half-written or hand-mangled file must never disable a working session.
		if (fresh === null) return;
		fresh.offset = Math.max(fresh.offset, config.offset);
		config = fresh;
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
					allowed_updates: ["message", "callback_query", "message_reaction"],
				},
				(LONG_POLL_S + 10) * 1000,
			);
			if (updates === null || updates.length === 0) return;
			// The long poll can outlive a lock steal; the batch then belongs to the new holder.
			if (!ownsLock()) return;
			let highest = config.offset - 1;
			for (const update of updates) {
				try {
					const handled = await handleUpdate(config, update);
					if (handled === false) break;
				} catch (error) {
					// One malformed or failing update must not wedge the batch: the offset still advances.
					pi.logger.warn("notify-telegram: skipped a malformed update", {
						update: update.update_id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				highest = Math.max(highest, update.update_id);
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
		const blocks: string[] = [messageHead(ask.ctx)];
		const position = ask.questions.length > 1 ? ` ${ask.index + 1} of ${ask.questions.length}` : "";
		blocks.push(`\u{1F534} Input needed${position}`);
		const header = question.header?.trim() ?? "";
		blocks.push(header.length > 0 ? `**${header}**\n${question.question}` : question.question);
		if (ask.context.length > 0) blocks.push(ask.context);
		// Every option gets its own section: the button label alone never explains a choice.
		for (const [index, option] of question.options.entries()) {
			const preview = option.preview?.trim() ?? "";
			const stance = stanceOf(question, option, index);
			const lines = [stance === null ? `**${option.label}**` : `**${option.label}** ${stance.marker}`];
			lines.push(option.description.trim());
			if (preview.length > 0) {
				const clipped = clip(preview, PREVIEW_MAX);
				// A preview is caller text: a fence run inside it would close the quote and spill the rest.
				const fence = fenceFor(clipped);
				lines.push(`${fence}\n${clipped}\n${fence}`);
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
				"",
				"question",
				{ context: ask.context, question },
			);
			return;
		}
		const sentMessage = await sendOrEdit(
			config,
			"sendMessage",
			{ chat_id: config.chatId, reply_markup: markup },
			body,
			"",
			"question",
			{ context: ask.context, question },
			(messageId) => {
				ask.messageId = messageId;
			},
		);
		if (sentMessage === null && pendingAsk === ask) {
			ask.messageId = null;
			writeSessionRecord(ask.ctx);
		}
	}

	/** Settled options survive as dead grey buttons. `settled`, not `keep`, which now means an untruncatable tail. */
	async function settleQuestionMessage(
		messageId: number | null,
		head: string,
		result: string,
		settled?: InlineButton[][],
		beforeRecord?: (messageId: number) => void,
	): Promise<void> {
		if (config === null || messageId === null) return;
		const inline_keyboard =
			settled === undefined
				? []
				: settled.map((row) => row.map((button) => ({ ...button, callback_data: SETTLED_CALLBACK, disabled: {} })));
		await sendOrEdit(
			config,
			"editMessageText",
			{ chat_id: config.chatId, message_id: messageId, reply_markup: { inline_keyboard } },
			`${head}\n\n${result}`,
			"",
			null,
			undefined,
			beforeRecord,
		);
	}

	/** The current question's message, under the same head the live message carried. Past the last question there is nothing to settle. */
	async function settleAskMessage(
		ask: PendingAsk,
		messageId: number | null,
		result: string,
		settled?: InlineButton[][],
		beforeRecord?: (messageId: number) => void,
	): Promise<void> {
		const question = ask.questions[ask.index];
		if (question === undefined) return;
		await settleQuestionMessage(
			messageId,
			`${messageHead(ask.ctx)}\n\n${question.question}`,
			result,
			settled,
			beforeRecord,
		);
	}

	/** Blocks nothing: a press starts the next turn. Only the latest stands. */
	async function sendStandingQuestion(
		ctx: ExtensionContext,
		title: string,
		recorded: TurnStatus,
		quiet: boolean,
		keep = "",
	): Promise<void> {
		if (config === null || recorded.options === undefined) return;
		const superseded = standingQuestion;
		standingSeq += 1;
		const id = `${sessionTag}-n${standingSeq.toString(36)}`;
		const prompt = recorded.question?.trim() || recorded.text;
		// The settled message keeps the same head as the live one, so the chat stays scannable by badge.
		const settlementHead = `${messageHead(ctx)}\n\n${prompt}`;
		// Every option gets its own section: a bare button is a choice the phone cannot judge.
		const blocks = [`${recorded.text}${recorded.question === undefined ? "" : `\n\n${recorded.question}`}`];
		for (const option of recorded.options) {
			const stance = stanceFor(option.recommended === true, option);
			const head = stance === null ? `**${option.label}**` : `**${option.label}** ${stance.marker}`;
			blocks.push(option.description === undefined ? head : `${head}\n${option.description}`);
		}
		const body = withHead(ctx, title, blocks.join("\n\n"));
		const keyboard = packRows(
			recorded.options.map((option, index) => {
				const stance = stanceFor(option.recommended === true, option);
				const button: InlineButton = {
					text: buttonText(option.label, stance === null ? "" : ` ${stance.marker}`),
					callback_data: `c:${id}:${index}`,
				};
				if (stance?.style !== undefined) button.style = stance.style;
				return button;
			}),
		);
		if (recorded.urgency === "green") keyboard.push([closeSessionButton()]);
		const labels = recorded.options.map((option) => option.label);
		const publishStanding = (messageId: number): void => {
			standingQuestion = { id, messageId, labels, head: settlementHead };
		};
		const sent = await sendStructured(
			config,
			{
				chat_id: config.chatId,
				reply_markup: { inline_keyboard: keyboard, force_reply: true },
				...urgencyExtras(recorded.urgency, quiet),
			},
			body,
			keep,
			"standing",
			recorded,
			publishStanding,
		);
		if (sent === null) standingQuestion = { id, messageId: null, labels, head: settlementHead };
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

	async function advance(ask: PendingAsk): Promise<boolean> {
		if (config === null) return false;
		const messageId = ask.messageId;
		const answered = ask.questions[ask.index];
		const chosen = [...(ask.selected[ask.index] ?? new Set<string>())];
		const shown = ask.custom[ask.index] ?? (chosen.length === 0 ? "no selection" : chosen.join(", "));
		let advanced = false;
		const publishAdvance = (settledMessageId: number): void => {
			if (pendingAsk !== ask || ask.messageId !== settledMessageId) return;
			ask.messageId = null;
			ask.index += 1;
			advanced = true;
		};
		if (answered !== undefined) {
			const labels = answered.options.map((option) => option.label);
			await settleAskMessage(
				ask,
				messageId,
				`**Answered:** ${shown}`,
				settledKeyboard(labels, new Set(chosen)),
				publishAdvance,
			);
		}
		if (!advanced) {
			if (messageId !== null) return pendingAsk !== ask || ask.messageId !== messageId;
			if (pendingAsk !== ask || ask.messageId !== null) return true;
			ask.index += 1;
			writeSessionRecord(ask.ctx);
		}
		if (ask.index >= ask.questions.length) {
			ask.finish(collectResults(ask));
			return true;
		}
		await presentQuestion(ask, false);
		if (pendingAsk !== ask) {
			// The terminal settled this ask while the next question was in flight; close the orphan keyboard.
			await settleAskMessage(ask, ask.messageId, "This question is no longer active.");
			ask.messageId = null;
		}
		return true;
	}

	async function applyCallback(ask: PendingAsk, payload: string): Promise<void> {
		const [action, tag, rawIndex, rawOption] = payload.split(":");
		if (tag !== ask.askId || Number.parseInt(rawIndex ?? "", 10) !== ask.index) return;
		const question = ask.questions[ask.index];
		if (question === undefined) return;

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

	async function closeReactionRouteForShutdown(): Promise<number> {
		mkdirSync(REACTION_ROUTE_LOCK_DIR, { recursive: true, mode: 0o700 });
		const closing = reactionRouteClosingFile(sessionId);
		writeFileSync(closing, randomUUID(), { flag: "wx", mode: 0o600 });
		try {
			const deadline = Date.now() + REACTION_ROUTE_WAIT_MS;
			let token: string | null = null;
			while (token === null && Date.now() < deadline) {
				token = takeReactionRouteLock(sessionId, true);
				if (token === null) await sleepMs(20);
			}
			if (token === null) {
				rmSync(reactionRouteLockFile(sessionId), { force: true });
				token = takeReactionRouteLock(sessionId, true);
				if (token === null) throw new Error("Could not fence the reaction inbox route");
			}
			try {
				const queuedRedos = discardQueuedRedos(sessionId);
				sessionAlive = false;
				if (sessionCtx !== null) writeSessionRecord(sessionCtx);
				return queuedRedos;
			} finally {
				releaseReactionRouteLock(sessionId, token);
			}
		} finally {
			rmSync(closing, { force: true });
		}
	}

	function discardQueuedRedos(target: string): number {
		const dir = join(INBOX_DIR, target);
		if (!existsSync(dir)) return 0;
		let discarded = 0;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const path = join(dir, name);
			try {
				const entry: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (
					entry === null ||
					typeof entry !== "object" ||
					!("kind" in entry) ||
					entry.kind !== "redo" ||
					!("value" in entry) ||
					typeof entry.value !== "string"
				) {
					continue;
				}
				rmSync(path, { force: true });
				discarded += 1;
			} catch (error) {
				pi.logger.warn("notify-telegram: could not reclassify a queued shutdown redo", {
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return discarded;
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
				if (parsed === null || typeof parsed !== "object") {
					pi.logger.warn("notify-telegram: discarded an inbox entry that is not an object", {
						name,
						raw: clip(raw, 200),
					});
					continue;
				}
				const entry = parsed as Partial<InboxEntry>;
				if (typeof entry.value !== "string" || entry.value.length === 0) {
					pi.logger.warn("notify-telegram: discarded an inbox entry with no value", { name, raw: clip(raw, 200) });
					continue;
				}
				// A reply or an answer means attention is on this session: put its window in front for the return.
				if (entry.kind === "text" || (entry.kind === "callback" && !entry.value.startsWith("k:"))) {
					focusTmuxWindow();
				}
				// `replyOwed` is set where the entry reaches the agent, never before: an entry answered
				// locally, such as an unreadable file, leaves no answer for this session to write.

				const ask = pendingAsk;
				if (entry.kind === "command") {
					if (entry.value === "hidequestions") {
						if (ask !== null && ask.messageId !== null) {
							await settleAskMessage(
								ask,
								ask.messageId,
								"Question hidden. It stays open at the terminal.",
								undefined,
								(messageId) => {
									if (pendingAsk === ask && ask.messageId === messageId) ask.messageId = null;
								},
							);
						}
						const standing = standingQuestion;
						if (standing !== null) {
							standingQuestion = null;
							if (sessionCtx !== null) writeSessionRecord(sessionCtx);
							await settleQuestionMessage(standing.messageId, standing.head, "Question hidden.");
						}
						retireCloseOffer(true);
					}
					if (entry.value === "stop" && sessionCtx !== null) {
						if (turnActive) {
							sessionCtx.abort();
							detach(sessionNotice(sessionCtx, "Stopping at your request."), "stop notice");
						} else {
							detach(sessionNotice(sessionCtx, "No turn is running here."), "stop notice");
						}
					}
					if (entry.value === "status" && sessionCtx !== null) {
						// Our own line has to be current before it is read back with everyone else's.
						writeSessionRecord(sessionCtx);
						// Context-prefixed even for the fleet answer, so the reply says which session composed it.
						await sessionNotice(sessionCtx, statusReport());
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
						if (label !== undefined) {
							pi.sendUserMessage(label);
							replyOwed = true;
						}
					} else if (sessionCtx !== null) {
						await sessionNotice(sessionCtx, "That question is closed. It was superseded or already answered.");
					} else {
						await serviceNotice("That question is closed. It was superseded or already answered.");
					}
					continue;
				}
				if (entry.kind === "callback") {
					if (ask !== null) {
						await applyCallback(ask, entry.value);
						replyOwed = true;
					} else if (sessionCtx !== null) {
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
						// No `deliverAs`: omp steers a running turn and starts one when idle. An explicit
						// steer only interrupts, so on a finished session it delivered nothing at all.
						closeReplyQuestion(entry.replyTo);
						pi.sendUserMessage([
							{ type: "image", data, mimeType: entry.mime },
							{ type: "text", text: caption.length > 0 ? caption : "(image sent from Telegram)" },
						]);
					} else {
						const tail = caption.length > 0 ? ` Caption: ${caption}` : "";
						closeReplyQuestion(entry.replyTo);
						pi.sendUserMessage(
							`The user sent a file from Telegram (${entry.mime ?? "unknown type"}), saved at ${entry.value}.${tail}`,
						);
					}
					replyOwed = true;
					ackDelivered(entry.messageId);
					continue;
				}
				// A grade on the open question answers it with the request to restate. A grade on any
				// other message is a steer, which omp queues behind a running turn or starts one with.
				if (entry.kind === "redo") {
					const standingStillOpen = entry.targetKind !== "standing" || standingQuestion?.messageId === entry.messageId;
					const statusStillOpen = entry.targetQuestion !== true || replyQuestionMessageId === entry.messageId;
					if (ask !== null && ask.messageId === entry.messageId) {
						focusTmuxWindow();
						ask.custom[ask.index] = entry.value;
						ask.selected[ask.index] = new Set<string>();
						if (await advance(ask)) {
							replyOwed = true;
						} else {
							const retryUpdateId = Number.parseInt(name, 10);
							if (isTelegramMessageId(retryUpdateId)) {
								deliver(sessionId, retryUpdateId, {
									kind: "redo",
									value: entry.value,
									messageId: entry.messageId,
									targetKind: entry.targetKind,
									targetQuestion: entry.targetQuestion,
									targetPreEdit: entry.targetPreEdit,
								});
							}
						}
						continue;
					}
					if (
						(entry.targetKind === "question" || !standingStillOpen || !statusStillOpen) &&
						entry.targetPreEdit !== true
					) {
						continue;
					}
					if (entry.targetQuestion === true) closeReplyQuestion(entry.messageId);
					focusTmuxWindow();
					pi.sendUserMessage(entry.value);
					replyOwed = true;
					continue;
				}
				if (entry.kind === "text") closeReplyQuestion(entry.replyTo);
				// The ask blocks the turn, so text arriving now can only be its answer: the question opens
				// the reply field itself, and a plain message routed here by the open question is the same.
				if (ask !== null) {
					ask.custom[ask.index] = entry.value;
					ask.selected[ask.index] = new Set<string>();
					replyOwed = true;
					await advance(ask);
					continue;
				}
				pi.sendUserMessage(entry.value);
				replyOwed = true;
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
			"Ask the interactive user one or more questions. Answerable at the terminal or from Telegram, whichever answers first. Set `context` when the question cannot be judged from the option list alone, for example the finding that prompted it or what each alternative costs. Context is shown in both places. Question, option and context text render as Markdown on Telegram. Supported: `inline code` for identifiers, paths and values, triple-backtick fences with a language for multi-line code, **bold**, *italic* or _italic_, ~~strikethrough~~, ||spoiler||, a leading angle bracket for a quoted line, a leading hash for a heading, and [label](https://url) links. Tables, bullet nesting and anything else render as plain text, so prefer a fenced block for tabular output. Mark desirability so a choice reads at a glance, as a three colour semaphore: set `recommended` to the index of the one option you would take, set `lukewarm` on an option that would work but that you would not pick, and set `discouraged` on an option offered only for contrast. Preferable renders green, lukewarm carries an orange marker, and discouraged renders red, all labelled, on Telegram and in the terminal. Leave every mark unset for options that are genuinely equivalent. Every option carries a one-line `description` of what choosing it does or costs: it is not optional, an option without one is refused, nothing is asked, and the refusal names the bare options. Options are the paths that are actually open, and the set must hold the one that is best once the work is finished, stated on its own terms and never folded into a cheaper option as a caveat. `recommended` marks that path, not the quickest one. Effort, edit count and churn are never grounds to prefer or to demote an option: a flaw sitting at many call sites is a reason to correct it now, not a reason to keep it. Offer a partial or temporary path only when a named concrete blocker, never cost, rules the complete one out; mark it `lukewarm` or `discouraged`, and let its description say which complete solution it defers and what the deferral costs. Where the repository is not the user's to break, a compatibility-keeping option may sit beside the complete one, and its description names the release that drops it. When one path is plainly better and nothing left in the choice is a matter of the user's taste or priorities, take it and report it instead of asking.",
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
			const p = params as { questions: AskQuestion[]; context?: unknown };
			// A button is the whole of what Telegram shows, so an option nobody explained is refused
			// before anything reaches the chat or the terminal, with the reason spelled out: an agent
			// told only "invalid" writes the same lazy list again.
			const unexplained = p.questions.flatMap((question) => {
				const naked = question.options
					.map((option, index) => ({ option, index }))
					.filter(({ option }) => (option.description ?? "").trim().length === 0)
					.map(({ option, index }) =>
						option.label.trim().length > 0 ? `"${option.label.trim()}"` : `option ${index + 1}`,
					);
				if (naked.length === 0) return [];
				const where = question.id.trim().length > 0 ? `question "${question.id.trim()}"` : "the question";
				return [`${where} offers ${naked.join(", ")} with no description`];
			});
			if (unexplained.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: nothing was asked because ${unexplained.join(", and ")}. A description is the line the user reads under the button, and on Telegram the label alone is what arrives, so an undescribed option is a choice the user cannot judge and may tap by mistake. Write one line per option saying what choosing it does or costs, name what the option gives up rather than repeating the label, and call ask again with the whole list.`,
						},
					],
					isError: true,
				};
			}
			const questions = p.questions as ExplainedQuestion[];
			const invoke = ctx.invokeTool;
			if (invoke === undefined) throw new Error("Ask tool requires interactive mode");
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
						return { ...rest, description: `${stance.marker} ${rest.description.trim()}` };
					}),
				})),
			};
			if (config === null) return await invoke(nativeParams, { signal, onUpdate });

			askSequence += 1;
			const remote = Promise.withResolvers<AskResult[]>();
			const ask: PendingAsk = {
				askId: `${sessionTag}-${askSequence.toString(36)}`,
				ctx,
				context,
				questions,
				index: 0,
				messageId: null,
				selected: questions.map(() => new Set<string>()),
				custom: questions.map(() => undefined),
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
					detach(settleAskMessage(ask, ask.messageId, "Answered at the terminal."), "terminal-answer edit");
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
				await settleAskMessage(
					ask,
					ask.messageId,
					aborted ? "Cancelled at the terminal." : "This question is no longer active.",
					undefined,
					(messageId) => {
						if (pendingAsk === ask && ask.messageId === messageId) pendingAsk = null;
					},
				);
				throw error;
			} finally {
				if (pendingAsk === ask) pendingAsk = null;
				// The record still says "waiting on a question" until this runs, which would send
				// the next plain message to a session that is no longer asking anything.
				noteState();
			}
		},
	});

	pi.registerTool({
		name: "notify_status",
		label: "Notify Status",
		description:
			"Record the turn-end Telegram notification, which is all the user sees when away from the terminal. Call it once, immediately before finishing a turn. `summary`: one or two plain sentences when no choice is attached, Markdown subset allowed. Be proactive about what comes next: name the concrete next steps when some exist, and state plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. When you believe the work is complete, weigh the follow-ups that fit what the turn was. After a bug fix, offer to hunt for surviving bugs of the same family, to complete the test coverage around the fix, and to run mutation testing to grade that coverage. After a feature, offer the related feature that naturally follows once this one is committed, a switch to a cleaner abstraction you found (a trait, generics, a blanket impl) before committing, a pass hunting for cleaner code, criterion benchmarks, or a strict review of the change as the repository's maintainer would run it. `urgency`: green when done and idle, orange when a reply is wanted, red when blocked on the user. Whenever any user action is wanted, also set `question` and 2 to 6 `options` drawn from those real next steps. Every option is an object with a short `label` naming the action and a one-line `description` of what choosing it does or costs, and at most one of `recommended`, `lukewarm` or `discouraged` to colour the button. The description is not optional: the button is the whole of what a phone shows, so an option with no description is refused and no status is recorded. Never use only a phase number or letter, such as `Start Phase 7`. Each description becomes its own section under the summary, and the buttons start the next turn with the most likely choice first. Omit `question` and `options` when there is genuinely nothing to ask, never pad with filler choices. The notification must be answerable from a phone without terminal context, so the `summary` names the decision and says why it is needed now. The next steps are held to the same standard as the work: the option that finishes the work properly belongs in the list and carries `recommended`, effort is never a reason to demote it, and any option that leaves a known defect standing says so in its own description and is marked `lukewarm` or `discouraged`. Text the user is meant to copy, an issue body, a PR post, a patch, goes out through `notify_snippet` instead of riding in the summary.",
		approval: "read",
		strict: true,
		parameters: z.object({
			summary: z.string(),
			urgency: z.string(),
			question: z.string().optional(),
			options: z
				.array(
					z.union([
						z.string(),
						z.object({
							label: z.string(),
							description: z.string().optional(),
							recommended: z.boolean().optional(),
							lukewarm: z.boolean().optional(),
							discouraged: z.boolean().optional(),
						}),
					]),
				)
				.optional(),
		}),
		async execute(_toolCallId, params) {
			const p = params as { summary?: unknown; urgency?: unknown; question?: unknown; options?: unknown };
			const summary = typeof p.summary === "string" ? p.summary.trim() : "";
			const raw = typeof p.urgency === "string" ? p.urgency.trim().toLowerCase() : "";
			if (raw !== "red" && raw !== "orange" && raw !== "green") {
				return {
					content: [{ type: "text", text: `Error: urgency must be green, orange or red, not "${raw}"` }],
					isError: true,
				};
			}
			const urgency = raw;
			if (summary.length === 0) {
				return { content: [{ type: "text", text: "Error: summary must not be empty" }], isError: true };
			}
			// A button is the whole of what a phone shows, so an option nobody explained is refused
			// outright: nothing is recorded, and the turn-end block asks for the list again. A list
			// that is merely degenerate, too short to be a choice or too long, still ships: the
			// summary and its question are answerable in plain words.
			const requested = Array.isArray(p.options) ? p.options : [];
			const parsed = requested.map(parseStatusOption);
			const unlabelled = parsed.filter((option) => option === null).length;
			const bare = parsed
				.filter((option): option is StatusOption => option !== null && option.description === undefined)
				.map((option) => `"${option.label}"`);
			if (unlabelled > 0 || bare.length > 0) {
				const faults: string[] = [];
				if (unlabelled > 0) faults.push(`${unlabelled} of ${requested.length} carry no label`);
				if (bare.length > 0) faults.push(`${bare.join(", ")} carry no description`);
				return {
					content: [
						{
							type: "text",
							text: `Error: nothing was recorded because ${faults.join(" and ")}. Every option is an object with a short label naming the action and a one-line description of what choosing it does or costs. Call notify_status again with the whole list.`,
						},
					],
					isError: true,
				};
			}
			const usable = parsed.filter((option): option is StatusOption => option !== null);
			const offered = usable.length >= STATUS_OPTIONS_MIN ? usable.slice(0, STATUS_OPTIONS_MAX) : [];
			const notes: string[] = [];
			if (offered.length > 0 && usable.length > offered.length) {
				notes.push(`only the first ${STATUS_OPTIONS_MAX} options were kept`);
			}
			if (requested.length > 0 && offered.length === 0) {
				notes.push(
					`fewer than ${STATUS_OPTIONS_MIN} options are not a choice, so the summary went out without buttons`,
				);
			}
			const clipped = summary.length > SUMMARY_MAX;
			turnSummary = {
				text: clip(summary, SUMMARY_MAX),
				urgency,
				question: typeof p.question === "string" && p.question.trim().length > 0 ? p.question.trim() : undefined,
				options: offered.length > 0 ? offered : undefined,
			};
			const told = [`Status recorded (${urgency}${offered.length > 0 ? ", with choices" : ""}).`];
			if (clipped) told.push(`The summary was truncated to ${SUMMARY_MAX} characters, write a shorter one.`);
			if (notes.length > 0) told.push(`${notes.join(", and ")}.`);
			return {
				content: [{ type: "text", text: told.join(" ") }],
				details: {
					urgency,
					options: offered.map((option) => option.label),
					truncated: clipped,
					droppedOptions: requested.length - offered.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "session_badge",
		label: "Session Badge",
		description:
			"Name this session in Telegram, where every running session competes for the same chat. `emoji` is one emoji depicting the work as closely as a single glyph can: a rat for a rat's metabolism, a lock for an auth bug, a broom for a cleanup. `label` is up to 60 characters naming the work. Call it as soon as the task is clear, and again when the work becomes something else. The emoji must be unique among live sessions: one already in use is refused, along with the list of what is taken, so choose the next-best depiction rather than a near-duplicate. A palette emoji is assigned at startup and describes nothing, so leaving it in place is the one wrong answer.",
		approval: "read",
		parameters: z.object({
			emoji: z.string().optional(),
			label: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { emoji?: unknown; label?: unknown };
			const wanted = typeof p.emoji === "string" ? p.emoji.trim() : "";
			const label = typeof p.label === "string" ? clip(p.label.trim(), 60) : null;
			const refuse = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { badge: badge(ctx), applied: false },
			});
			if (wanted.length > 0 && !isBadgeEmoji(wanted)) {
				return refuse(
					`"${wanted}" is not a single emoji, so the badge is unchanged. Pass one emoji that depicts the work.`,
				);
			}
			const before = { emoji: badgeEmoji, chosen: badgeChosen, label: badgeOverride };
			const claimed = await withBadgeClaim(
				() => {
					const rival = wanted.length === 0 ? undefined : badgesInUse().get(wanted);
					if (rival !== undefined) return rival;
					if (wanted.length > 0) {
						badgeEmoji = wanted;
						badgeChosen = true;
					}
					if (label !== null) badgeOverride = label;
					writeSessionRecord(ctx);
					return null;
				},
				() => {
					badgeEmoji = before.emoji;
					badgeChosen = before.chosen;
					badgeOverride = before.label;
					writeSessionRecord(ctx);
				},
			);
			if (!claimed.ok) {
				return refuse("Another session is claiming a badge right now, so nothing changed. Call this again.");
			}
			if (claimed.value !== null) {
				const taken = [...badgesInUse().keys()].join(" ");
				return refuse(
					`${wanted} is already in use by ${badgeOf(claimed.value)}, so the badge is unchanged. In use: ${taken}. Pick another emoji that depicts this work.`,
				);
			}
			return {
				content: [{ type: "text", text: `Badge is now: ${badge(ctx)}` }],
				details: { badge: badge(ctx), applied: true },
			};
		},
	});

	/**
	 * The startup badge comes from a fixed palette and says nothing about the work, and only the
	 * model knows what the work is. The request rides the turn as hidden context and stops the
	 * moment a badge is chosen: a session that complies never sees it twice, one that ignores it is
	 * asked again next turn.
	 */
	pi.on("before_agent_start", async () => {
		if (config === null || badgeChosen) return undefined;
		const taken = [...badgesInUse().keys()].join(" ");
		const standing =
			badgeEmoji.length === 0
				? "This session carries no emoji in Telegram: every placeholder is already held by another session."
				: `This session shows ${badgeEmoji} in Telegram, a placeholder from a fixed palette that describes nothing.`;
		return {
			message: {
				customType: "telegram-badge",
				display: false,
				content:
					`${standing} Call session_badge with an emoji that depicts this task as closely as one glyph can, plus a short label naming it, so its notifications are recognisable among the other sessions.` +
					(taken.length === 0 ? "" : ` Held by other live sessions and therefore refused: ${taken}.`),
			},
		};
	});

	/** Multipart upload for outbound files; JSON callTelegram cannot carry bytes. */
	async function uploadTelegram<T>(
		cfg: Config,
		method: string,
		fields: Record<string, string | number>,
		files: Array<{ field: string; name: string; data: Uint8Array }>,
	): Promise<T | null> {
		try {
			const { response, envelope } = await sendWithRetry(() => {
				const form = new FormData();
				for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
				for (const file of files) {
					form.append(file.field, new Blob([file.data as Uint8Array<ArrayBuffer>]), file.name);
				}
				return fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
					method: "POST",
					body: form,
					signal: AbortSignal.timeout(120_000),
				});
			});
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
			"Send files from disk to the user's Telegram chat, for artifacts the user should see on their phone: a screenshot, a rendered diff, a report, a build output. `paths`: 1 to 10 file paths under the session workspace or the system tmp directory (copy anything else into the workspace first). Images arrive as photos and several images become one album, everything else arrives as a document (50 MB per file, 100 MB per call). Each file is renamed `<UTC stamp>__<kind>__<session>__<original name>` and carries that name in its caption, so the user can search for it. `caption`: optional short plain text shown with the first file. `mode`: `auto` lets Telegram compress and downscale a recognised image into a photo, `document` uploads the original bytes untouched under the same standard name, which is what a user asking for a lossless or full-resolution image wants.",
		approval: "read",
		strict: true,
		parameters: z.object({
			paths: z.array(z.string()).min(1).max(10),
			caption: z.string().optional(),
			mode: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { paths: string[]; caption?: unknown; mode?: unknown };
			if (config === null) {
				return { content: [{ type: "text", text: "Error: Telegram is not configured" }], isError: true };
			}
			const cfg = config;
			const requestedMode = typeof p.mode === "string" ? p.mode.trim().toLowerCase() : "";
			const mode = requestedMode.length === 0 ? "auto" : requestedMode;
			if (mode !== "auto" && mode !== "document") {
				return {
					content: [{ type: "text", text: `Error: mode must be auto or document, not "${requestedMode}"` }],
					isError: true,
				};
			}
			const requestedCaption = typeof p.caption === "string" ? p.caption.trim() : "";
			const context = messageHead(ctx);
			const sentSession = snapshotSentSession();
			const separator = requestedCaption.length > 0 ? "\n\n" : "";
			const at = Date.now();
			const owner = fileOwner(sessionTag, badgeEmoji);
			const nameOf = (original: string, kind: string): string => standardFileName({ at, kind, owner, original });
			const allowedRoots = [ctx.cwd, tmpdir(), MEDIA_DIR];
			const loaded: Array<{ path: string; original: string; data: Uint8Array; photo: boolean }> = [];
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
				const original = path.split("/").at(-1) ?? "file";
				// Document delivery is the caller's explicit choice, so no extension or size test applies.
				const photo =
					mode === "auto" && /\.(png|jpe?g|gif|webp|bmp)$/iu.test(original) && data.byteLength <= 10 * 1024 * 1024;
				loaded.push({ path, original, data, photo });
			}

			// Telegram strips a photo's filename, so the name rides in the caption; its room is
			// reserved before the caller's text is clipped, at the longer of the two kind words.
			const longest = Math.max(...loaded.map((file) => nameOf(file.original, "document").length));
			const callerLimit = Math.max(0, CAPTION_MAX - context.length - separator.length - longest - 2);
			const callerCaption = clip(requestedCaption, callerLimit);
			const head = callerCaption.length > 0 ? `${context}${separator}${callerCaption}` : context;
			const captionOf = (name: string, lead: boolean): string => (lead ? `${head}\n\n${name}` : name);

			const base: Record<string, string | number> = { chat_id: config.chatId };
			const sentIds: number[] = [];
			if (loaded.length > 1 && loaded.every((file) => file.photo)) {
				const names = loaded.map((file) => nameOf(file.original, "photo"));
				const media = loaded.map((_file, index) => ({
					type: "photo",
					media: `attach://f${index}`,
					caption: captionOf(names[index] ?? "", index === 0),
				}));
				showUploading("upload_photo");
				const sent = await withSentRecordMarker(async () => {
					const accepted = await uploadTelegram<TelegramMessage[]>(
						cfg,
						"sendMediaGroup",
						{ ...base, media: JSON.stringify(media) },
						loaded.map((file, index) => ({
							field: `f${index}`,
							name: names[index] ?? file.original,
							data: file.data,
						})),
					);
					if (accepted !== null) {
						for (const [index, message] of accepted.entries()) {
							trackSent(message, "file", media[index]?.caption ?? "", sentSession);
						}
					}
					return accepted;
				});
				if (sent === null) {
					return { content: [{ type: "text", text: "Error: Telegram rejected the album upload" }], isError: true };
				}
				for (const message of sent) sentIds.push(message.message_id);
			} else {
				for (const [index, file] of loaded.entries()) {
					const kind = file.photo ? "photo" : "document";
					const name = nameOf(file.original, kind);
					const fields: Record<string, string | number> = { ...base, caption: captionOf(name, index === 0) };
					fields[kind] = "attach://f0";
					let visibleCaption = String(fields.caption);
					showUploading(file.photo ? "upload_photo" : "upload_document");
					const sent = await withSentRecordMarker(async () => {
						let accepted = await uploadTelegram<TelegramMessage>(
							cfg,
							file.photo ? "sendPhoto" : "sendDocument",
							fields,
							[{ field: "f0", name, data: file.data }],
						);
						// Telegram rejects photos over its dimension limits; the same bytes go through as a document.
						if (accepted === null && file.photo) {
							const fallback = nameOf(file.original, "document");
							const retry: Record<string, string | number> = {
								...base,
								caption: captionOf(fallback, index === 0),
								document: "attach://f0",
							};
							showUploading("upload_document");
							accepted = await uploadTelegram<TelegramMessage>(cfg, "sendDocument", retry, [
								{ field: "f0", name: fallback, data: file.data },
							]);
							visibleCaption = String(retry.caption);
						}
						if (accepted !== null) trackSent(accepted, "file", visibleCaption, sentSession);
						return accepted;
					});
					if (sent === null) {
						return {
							content: [{ type: "text", text: `Error: Telegram rejected the upload of ${file.path}` }],
							isError: true,
						};
					}
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

	/**
	 * Text the user has to paste somewhere else. The message ends on a single fenced block holding
	 * the payload verbatim, so the copy control Telegram draws on that block yields exactly the
	 * payload and nothing of ours. It deliberately skips `sendStructured`: a payload must not be
	 * handed to a markdown renderer whose fence rules are not the ones measured here, and it is
	 * never truncated, because half an issue body is worse than none.
	 */
	pi.registerTool({
		name: "notify_snippet",
		label: "Notify Snippet",
		description:
			"Send the user text they are meant to copy: an issue body, a PR post, a review reply, a patch, a command, a config block. It arrives as one Telegram message whose last element is a single fenced block holding the text verbatim, so the block's copy control yields exactly the payload with nothing of yours around it. `purpose`: a short line naming what the text is and where it goes, such as `PR body for #9` or `reply to the review comment`. `text`: the payload itself, unprefixed and unquoted, with no leading `>` or `!` markers. `language`: an optional bare fence tag such as `ts`, `md` or `bash` for colouring, and left off for prose. Markdown inside the payload is shown, never rendered, and a payload carrying its own fence still arrives as one block. One block per call, so send several by calling several times. Nothing is ever truncated: a payload too large for one message is refused, with the room that is left, and anything bigger belongs in a file sent through `notify_file`.",
		approval: "read",
		strict: true,
		parameters: z.object({
			purpose: z.string(),
			text: z.string(),
			language: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { purpose?: unknown; text?: unknown; language?: unknown };
			if (config === null) {
				return { content: [{ type: "text", text: "Error: Telegram is not configured" }], isError: true };
			}
			const purpose = typeof p.purpose === "string" ? clip(p.purpose.trim(), SNIPPET_PURPOSE_MAX) : "";
			// Trailing newlines are invisible in a code block and only cost room, never meaning.
			const payload = typeof p.text === "string" ? p.text.replace(/\n+$/, "") : "";
			const language = typeof p.language === "string" ? p.language.trim() : "";
			if (purpose.length === 0) {
				return {
					content: [{ type: "text", text: 'Error: purpose must say where the text goes, such as "PR body for #9"' }],
					isError: true,
				};
			}
			if (payload.trim().length === 0) {
				return { content: [{ type: "text", text: "Error: text must not be empty" }], isError: true };
			}
			if (!/^[A-Za-z0-9_+-]*$/u.test(language)) {
				return {
					content: [
						{ type: "text", text: `Error: language must be a bare fence tag such as ts or bash, not "${language}"` },
					],
					isError: true,
				};
			}
			const fence = fenceFor(payload);
			// Everything above the block is a plain label, and a backtick run in a session name or in
			// the purpose would open a fence that swallows the payload's own opener, leaving the text
			// meant for copying outside the block.
			const label = `${messageHead(ctx)}\n\n**\u{1F4CB} Copy: ${purpose}**`.replaceAll("`", "");
			const plain = `${label}\n${fence}${language}\n${payload}\n${fence}`;
			// The same budget `fitToTelegram` fits against, checked here so an oversized payload is
			// refused whole rather than arriving cut in half.
			const size = plain.length;
			if (size > TELEGRAM_TEXT_MAX) {
				const room = Math.max(0, payload.length - (size - TELEGRAM_TEXT_MAX));
				return {
					content: [
						{
							type: "text",
							text: `Error: nothing was sent, because the message would be ${size} characters against Telegram's ${TELEGRAM_TEXT_MAX} and text meant for pasting must never be cut. Send about ${room} characters or fewer, split it over several calls, or write it to a file and send that with notify_file.`,
						},
					],
					isError: true,
				};
			}
			const sent = await sendOrEdit(config, "sendMessage", { chat_id: config.chatId }, plain, "", "snippet");
			if (sent === null) {
				return { content: [{ type: "text", text: "Error: Telegram rejected the snippet" }], isError: true };
			}
			lastNotifiedAt = Date.now();
			writeSessionRecord(ctx);
			return {
				content: [{ type: "text", text: `Sent ${payload.length} characters as a copyable block.` }],
				details: { messageId: sent.message_id, characters: payload.length },
			};
		},
	});

	/**
	 * The hard gate before anything is forked or opened. Reuses the same `pendingAsk` path the ask tool
	 * uses, so the Launch/Cancel card is answerable from the phone and an abort or a Cancel leaves nothing
	 * behind. Returns true only for an explicit Launch.
	 */
	async function confirmUpstreamLaunch(
		ctx: ExtensionContext,
		question: string,
		context: string,
		signal: AbortSignal | undefined,
	): Promise<{ confirmed: boolean; delivered: boolean }> {
		if (config === null) return { confirmed: false, delivered: false };
		askSequence += 1;
		const remote = Promise.withResolvers<AskResult[]>();
		const ask: PendingAsk = {
			askId: `${sessionTag}-${askSequence.toString(36)}`,
			ctx,
			context,
			questions: [
				{
					id: "upstream-launch",
					question,
					options: [
						{
							label: "Launch",
							description:
								"Fork or reuse the repository, open a new omp session in a tmux tab, and start the upstream work.",
						},
						{ label: "Cancel", description: "Do nothing. Stay in this session and drop the upstream launch." },
					],
					recommended: 0,
				},
			],
			index: 0,
			messageId: null,
			selected: [new Set<string>()],
			custom: [undefined],
			finish: remote.resolve,
		};
		const previous = pendingAsk;
		pendingAsk = ask;
		try {
			await presentQuestion(ask, false);
		} catch (error) {
			// A network throw from the send must not leave pendingAsk bound to a card that never showed.
			if (pendingAsk === ask) pendingAsk = previous;
			noteState();
			pi.logger.warn("upstream: the launch confirmation card failed to send", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { confirmed: false, delivered: false };
		}
		if (ask.messageId === null) {
			// The card never reached Telegram, so there is nothing for the user to answer; do not block.
			if (pendingAsk === ask) pendingAsk = previous;
			noteState();
			return { confirmed: false, delivered: false };
		}
		lastNotifiedAt = Date.now();
		writeSessionRecord(ctx);
		const onAbort = (): void => remote.resolve([]);
		signal?.addEventListener("abort", onAbort);
		// An AbortSignal fires "abort" once; if it is already aborted the listener never runs, so settle now.
		if (signal?.aborted) onAbort();
		try {
			const results = await remote.promise;
			const answer = (results[0]?.selectedOptions[0] ?? results[0]?.customInput ?? "").trim().toLowerCase();
			return { confirmed: answer === "launch", delivered: true };
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (pendingAsk === ask) {
				pendingAsk = previous;
				if (ask.messageId !== null)
					detach(settleAskMessage(ask, ask.messageId, "Launch cancelled."), "upstream-confirm close");
			}
			noteState();
		}
	}

	pi.registerTool({
		name: "upstream_launch",
		label: "Upstream Launch",
		description:
			"Start the upstream procedure for a fix that belongs in a repository this one depends on. Call it only after you have written the upstream request document (per the upstream-finding-as-document rule) and the user has agreed an upstream fix is wanted. It opens a Telegram Launch/Cancel card and does nothing until Launch is tapped. On Launch it resolves the target on the user's GitHub account (their own repository when they own it, otherwise a fork it reuses or creates), ensures a clone under `~/github`, cuts a worktree on a new `upstream/<slug>` branch off the latest default branch so it never disturbs work already open there, carries the request document into that worktree, and opens a new omp session in a fresh tmux tab to carry out the fix. It writes only on the user's account and under `~/github`, never in this repository, and the spawned session does the upstream work from there. `repo`: the uphill repository as `owner/name`. `document`: path to the request document you wrote, resolved against this session's working directory. `problem`: one sentence naming what the dependency does wrong, shown on the card and given to the new session. `slug`: optional short kebab identifier for the branch and worktree, derived from `problem` when omitted.",
		approval: "read",
		strict: true,
		parameters: z.object({
			repo: z.string(),
			document: z.string(),
			problem: z.string(),
			slug: z.string().optional(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as { repo?: unknown; document?: unknown; problem?: unknown; slug?: unknown };
			const fail = (text: string): { content: { type: "text"; text: string }[]; isError: true } => ({
				content: [{ type: "text", text: `Error: ${text}` }],
				isError: true,
			});
			if (config === null) {
				return fail(
					"Telegram is not configured, and this procedure runs through the bot; start it from a session paired with the Telegram bot.",
				);
			}
			if (process.env.TMUX === undefined) {
				return fail("no tmux session is attached, so a new tab cannot be opened; run omp inside tmux");
			}
			const validated = validateLaunchParams(p, ctx.cwd);
			if (!validated.ok) return fail(validated.error);
			const { args, docPath } = validated;

			const context = `Upstream target: ${args.owner}/${args.name}\nProblem: ${args.problem}\nRequest document: ${docPath}`;
			const decision = await confirmUpstreamLaunch(
				ctx,
				`Launch the upstream procedure for \`${args.owner}/${args.name}\`?`,
				context,
				signal,
			);
			if (!decision.delivered) {
				return fail(
					"could not send the Launch confirmation to Telegram, so nothing was launched; check the bot connection and retry",
				);
			}
			if (!decision.confirmed) {
				return {
					content: [{ type: "text", text: "Upstream launch cancelled; nothing was forked, cloned, or opened." }],
					details: { launched: false },
				};
			}

			const outcome = await performUpstreamLaunch(args);
			if (!outcome.ok) return fail(outcome.error);
			const where =
				outcome.mode === "own" ? "your own repository" : outcome.created ? "a new fork" : "your existing fork";
			detach(
				notify(
					ctx,
					"notice",
					"\u2B06\uFE0F Upstream launched",
					`${outcome.owner}/${outcome.name} \u2014 ${args.problem}\nBranch \`${outcome.branch}\` in ${where}. It runs in its own tmux tab now.`,
				),
				"upstream launch notice",
			);
			lastNotifiedAt = Date.now();
			writeSessionRecord(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Launched the upstream session for ${outcome.owner}/${outcome.name} in ${where}. Worktree ${outcome.worktreePath} on branch ${outcome.branch}, tmux window ${outcome.windowId}. Your work here is done: the new session carries the fix from here.`,
					},
				],
				details: { launched: true, ...outcome },
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
		resetReactionRouteForStartup(sessionId);
		sessionAlive = true;
		mkdirSync(join(INBOX_DIR, sessionId), { recursive: true, mode: 0o700 });
		reapDeadSessions();
		reapOldFiles();
		sessionTag = claimTag();
		// Base-36 tag as a number: stable across resumes, unique across live sessions.
		draftId = Number.parseInt(sessionTag, 36) + 1;
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
		replyQuestionMessageId = previous?.replyQuestion ?? null;
		if (existsSync(LOCK_FILE) && statSync(LOCK_FILE).isDirectory()) {
			rmSync(LOCK_FILE, { recursive: true, force: true });
		}
		rmSync(LEGACY_LOCK_DIR, { recursive: true, force: true });
		// The badge is claimed and persisted under one claim, so a session starting at the same moment
		// cannot validate the same free emoji before this record exists.
		const claimed = await withBadgeClaim(
			() => {
				const taken = new Set(badgesInUse().keys());
				const keeps = previous !== null && previous.emoji.length > 0 && !taken.has(previous.emoji);
				badgeEmoji = keeps ? previous.emoji : freeBadge(taken);
				badgeChosen = keeps && previous.emojiChosen;
				writeSessionRecord(ctx);
			},
			() => {
				// Nothing about the badge survives outside the claim: a duplicate emoji defeats the point
				// of having one, so the session starts badge-less and the heartbeat keeps trying. The
				// record itself has to exist regardless, because routing a reply reads it.
				badgeEmoji = "";
				badgeChosen = false;
				writeSessionRecord(ctx);
			},
		);
		if (!claimed.ok) {
			pi.logger.warn("notify-telegram: badge claim unavailable at startup, retrying on the heartbeat");
		}
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
						{ command: "stop", description: "Abort the running turn, reply to pick the session" },
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
				reloadConfig();
				writeSessionRecord(ctx);
				if (badgeEmoji.length === 0) detach(claimBadgeIfMissing(ctx), "badge claim");
				reapOldFiles();
				reapHeldMessages();
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
				maybeDashboard();
				// Re-read rather than trusting a boolean: two pollers caused 918 Telegram conflicts.
				if (ownsLock()) detach(pollOnce(), "telegram poll");
			} catch (error) {
				pi.logger.warn("notify-telegram: drain failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, DRAIN_MS);

		writeSessionRecord(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		turnSummary = null;
		statusBlockUsed = false;
		unpinRed(ctx);
		closeReplyQuestion();
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
		closeReplyQuestion();
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
		turnStartedAt = Date.now();
		turnEndedAt = 0;
		noticedKinds.clear();
		// The note describes the turn that hit the trouble, so a fresh turn starts clean.
		turnHealth = "";
		noteState();
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		replyOwed = false;
		turnEndedAt = Date.now();
		approvalWaiting = false;
		draftText = "";
		draftDirty = false;
		currentTool = "";
		askStream = null;
		askPreview = "";
		noteState();
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
		// The draft this rides in already opens with the session head, badge included.
		const blocks: string[] = ["\u{1F534} Input needed (the question is still being written)"];
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
		currentTool = clip(`${typeof event.toolName === "string" ? event.toolName : "tool"}${intent}`, 80);
		draftDirty = true;
		noteState();
	});

	pi.on("tool_execution_end", async () => {
		currentTool = "";
		draftDirty = true;
		noteState();
	});

	pi.on("auto_retry_start", async (event) => {
		if (typeof event.attempt !== "number" || event.attempt < 2) return;
		healthNote(`retrying (${event.attempt}/${event.maxAttempts})`);
	});

	pi.on("retry_fallback_applied", async (event) => {
		healthNote(`fell back to ${event.to}`);
	});

	pi.on("retry_fallback_succeeded", async (event) => {
		healthNote(`recovered on ${event.model}`);
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
			failure = clip(event.errorMessage, PREVIEW_MAX);
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
		replyOwed = false;
		approvalWaiting = false;
		if (config === null || !config.notifyOnTurnEnd) return;
		const quiet = Date.now() - lastLocalInput < config.quietSeconds * 1000;

		if (turnSummary !== null) {
			const heads = {
				green: "\u{1F7E2} Turn finished",
				orange: "\u{1F7E0} Reply wanted",
				red: "\u{1F534} Action required",
			};
			const recorded = turnSummary;
			turnSummary = null;
			// The record keeps the headline only: `/status` lists it beside every other session.
			lastSummary = clip(recorded.text.split("\n")[0]?.trim() ?? "", STATUS_SUMMARY_MAX);
			lastSummaryAt = Date.now();
			if (recorded.options === undefined) {
				const extra: Record<string, unknown> = { ...urgencyExtras(recorded.urgency, quiet) };
				if (recorded.urgency === "green") extra.reply_markup = { inline_keyboard: [[closeSessionButton()]] };
				// With no buttons the question would otherwise vanish, and a plain reply answers it fine.
				const body = recorded.question === undefined ? recorded.text : `${recorded.text}\n\n${recorded.question}`;
				const replyQuestionToken = recorded.question === undefined ? null : ++replyQuestionGeneration;
				const registerReplyQuestion = (messageId: number): void => {
					if (replyQuestionToken === replyQuestionGeneration) replyQuestionMessageId = messageId;
				};
				const work = notify(
					ctx,
					"status",
					heads[recorded.urgency],
					body,
					extra,
					usageFooter(),
					recorded,
					replyQuestionToken === null ? undefined : registerReplyQuestion,
				).then((sent) => {
					const messageId = isTelegramMessageId(sent?.message_id) ? sent.message_id : null;
					if (recorded.urgency === "green") {
						closeOfferMessageId = messageId;
						writeSessionRecord(ctx);
					}
					if (recorded.urgency === "red") return pinRed(ctx, sent);
					return undefined;
				});
				detach(work, "turn-end notice");
				return;
			}
			detach(sendStandingQuestion(ctx, heads[recorded.urgency], recorded, quiet, usageFooter()), "turn-end question");
			return;
		}

		if (!statusBlockUsed) {
			statusBlockUsed = true;
			if (pendingAsk === null && /\?\s*$/.test(lastAssistantTail(ctx))) {
				return { decision: "block" as const, reason: QUESTION_STOP_REASON };
			}
			return {
				decision: "block" as const,
				reason:
					"Before finishing, call notify_status with a one-or-two-sentence summary when no choice is attached and an urgency (green done, orange reply wanted, red blocked). Be proactive about next steps: name the concrete ones when they exist, and say plainly that nothing remains when the work is complete. Never invent a next step just to have one to offer. When you believe the work is complete, weigh the follow-ups that fit what the turn was. After a bug fix, offer to hunt for surviving bugs of the same family, to complete the test coverage around the fix, and to run mutation testing to grade that coverage. After a feature, offer the related feature that naturally follows once this one is committed, a switch to a cleaner abstraction you found (a trait, generics, a blanket impl) before committing, a pass hunting for cleaner code, criterion benchmarks, or a strict review of the change as the repository's maintainer would run it. If any user action is wanted, also set question and 2 to 6 options drawn from those real next steps. Every option is an object with a short label naming the action and a one-line description saying what choosing it does or costs: a button is all a phone shows, so an option with no description is refused and nothing is recorded. The notification must be answerable from a phone without terminal context. Never use only a phase number or letter, such as `Start Phase 7`. The buttons start the next turn, and the most likely choice goes first. Omit them when there is genuinely nothing to ask. The next steps are held to the same standard as the work: the option that finishes the work properly belongs in the list and carries `recommended`, effort is never a reason to demote it, and any option that leaves a known defect standing says so in its own description and is marked `lukewarm` or `discouraged`.",
			};
		}

		const tail = lastAssistantTail(ctx);
		const wantsReply = /\?\s*$/.test(tail);
		const title = wantsReply ? "\u{1F7E0} Reply wanted" : "\u{1F7E2} Turn finished";
		const body =
			tail.length === 0
				? "Awaiting your next instruction."
				: tail.length <= 600
					? tail
					: wantsReply
						? `...${clipEnd(tail, 600)}`
						: `${clip(tail, 600)}...`;
		detach(
			notify(ctx, "status", title, body, quiet ? { disable_notification: true } : {}, usageFooter()),
			"turn-end notice",
		);
	});

	pi.on("tool_approval_requested", async (event, ctx) => {
		approvalWaiting = true;
		noteState();
		if (config === null) return;
		const tool = event.toolName;
		const notice: ApprovalNotice = {
			toolCallId: event.toolCallId,
			toolName: tool,
			messageId: null,
			resolution: null,
		};
		approvalNotice = notice;
		const work = notify(ctx, "approval", "\u{1F534} Approval needed", `${tool} is waiting for approval.`).then(
			(sent) => {
				notice.messageId = typeof sent?.message_id === "number" ? sent.message_id : null;
				if (notice.messageId === null && notice.resolution !== null && approvalNotice === notice) {
					approvalNotice = null;
					return;
				}
				finishApprovalNotice(ctx, notice);
			},
		);
		detach(work, "approval notice");
	});

	pi.on("tool_approval_resolved", async (event, ctx) => {
		approvalWaiting = false;
		noteState();
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

	pi.on("session_shutdown", async () => {
		const queuedRedos = await closeReactionRouteForShutdown();
		if (queuedRedos > 0) {
			await serviceNotice("Grade kept, but this session ended before its queued redo could reach the agent.", false);
		}
		unsubscribeInput?.();
		unsubscribeInput = null;
		retireCloseOffer(true);
		const ask = pendingAsk;
		if (ask !== null) {
			pendingAsk = null;
			const messageId = ask.messageId;
			ask.messageId = null;
			if (config !== null) {
				detach(settleAskMessage(ask, messageId, "This question is no longer active."), "pending-question close");
			}
		}
		const standing = standingQuestion;
		if (standing !== null) {
			standingQuestion = null;
			if (sessionCtx !== null) writeSessionRecord(sessionCtx);
			if (config !== null) {
				detach(
					settleQuestionMessage(standing.messageId, standing.head, "**Session closed.**"),
					"standing-question close",
				);
			}
		}
		if (sessionCtx !== null) unpinRed(sessionCtx);
		closeReplyQuestion();
		sessionAlive = false;
		if (sessionCtx !== null) writeSessionRecord(sessionCtx);
		releaseLock();
		// Handing the board on rather than leaving the next owner to wait out a stale claim.
		releaseLock(DASHBOARD_LOCK_FILE);
	});
}
