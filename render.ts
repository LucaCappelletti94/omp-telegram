/**
 * Pure rendering helpers: Markdown to Telegram HTML, size fitting, button packing, option stance.
 * Nothing here touches the network, the filesystem, or session state, so `test/render.test.mjs`
 * drives it directly instead of through the fake server.
 */

export const TELEGRAM_TEXT_MAX = 4096;
export const TRUNCATION_NOTE = "\n\n(truncated, full text at the terminal)";

/**
 * Single source for stance marker and colour. Telegram button styles offer only
 * red, green and blue, so the middle stance carries its colour in the marker.
 */
export const STANCE = {
	preferable: { marker: "(preferable)", style: "success" as const },
	lukewarm: { marker: "\u{1F7E0} (lukewarm)", style: undefined },
	discouraged: { marker: "(discouraged)", style: "danger" as const },
};

export interface InlineButton {
	text: string;
	callback_data: string;
	style?: "danger" | "success" | "primary";
	disabled?: Record<string, never>;
}

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
	/** Workable, but not the pick. */
	lukewarm?: boolean;
	/** Present only for contrast. */
	discouraged?: boolean;
}

export interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	header?: string;
	multi?: boolean;
	recommended?: number;
}

/** A turn-end choice. `ask` carries the recommendation on the question, this carries it per option. */
export interface StatusOption {
	label: string;
	description?: string;
	recommended?: boolean;
	lukewarm?: boolean;
	discouraged?: boolean;
}

/** Preferable wins over discouraged, which wins over lukewarm, when a caller marks contradictions. */
export function stanceFor(recommended: boolean, option: { lukewarm?: boolean; discouraged?: boolean }) {
	if (recommended) return STANCE.preferable;
	if (option.discouraged === true) return STANCE.discouraged;
	if (option.lukewarm === true) return STANCE.lukewarm;
	return null;
}

export function stanceOf(question: AskQuestion, option: AskOption, index: number) {
	return stanceFor(question.recommended === index, option);
}

/** Emoji, then the working folder, then whatever names the work. */
export function badgeLine(emoji: string, cwd: string, detail: string, fallback: string): string {
	const folder =
		cwd
			.split("/")
			.filter((part) => part.length > 0)
			.pop() ?? cwd;
	return `${emoji} ${folder} \u00B7 ${detail.length > 0 ? detail.slice(0, 60) : fallback}`;
}

/** Coarse elapsed time; a fleet overview never needs seconds past a minute. */
export function ago(when: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - when) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
}

/** Compact elapsed time for the usage footer. */
export function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`;
	return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Absolute wall-clock time, deliberately not a relative "4m ago". A pinned board is rewritten
 * only when its text changes, and a relative stamp would change every second and edit forever.
 */
export function clockTime(when: number): string {
	const at = new Date(when);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Markdown subset to Telegram HTML. Code is stashed first so emphasis cannot touch it. */
export function toTelegramHtml(source: string): string {
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

/** A raw slice can end on the high half of a surrogate pair, which Telegram rejects. */
function dropLoneHighSurrogate(text: string): string {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** A UTF-16 length cap that never cuts an emoji in half. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : dropLoneHighSurrogate(text.slice(0, max));
}

/**
 * Telegram measures the rendered form, which escaping inflates up to fivefold, so the longest
 * fitting prefix is searched rather than computed. `keep` is a short tail, today the usage footer,
 * that survives the cut.
 */
export function fitToTelegram(plain: string, keep: string): string {
	const whole = plain + keep;
	if (toTelegramHtml(whole).length <= TELEGRAM_TEXT_MAX) return dropLoneHighSurrogate(whole);
	const build = (n: number): string => {
		let head = dropLoneHighSurrogate(plain.slice(0, n).trimEnd());
		// An odd fence count means the cut landed inside a code block, which would otherwise
		// degrade to literal backticks for the whole remaining message.
		if ((head.match(/```/g)?.length ?? 0) % 2 === 1) head += "\n```";
		return `${head}${TRUNCATION_NOTE}${keep}`;
	};
	let low = 0;
	let high = plain.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (toTelegramHtml(build(mid)).length <= TELEGRAM_TEXT_MAX) low = mid;
		else high = mid - 1;
	}
	return build(low);
}

/** Best-effort question texts from a half-streamed ask tool-call JSON, tolerant of a cut mid-string. */
export function extractQuestionPreviews(partialJson: string): string[] {
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

/**
 * Telegram offers no button sizing: a row spans the message width, split equally among its buttons.
 * Adaptive size therefore means adaptive packing: short labels share a row, long labels get a full
 * row. Two-up when both fit 16 cells and 26 combined, three-up when all fit 9, measured on the rendered text.
 */
export function packRows(buttons: InlineButton[]): InlineButton[][] {
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
