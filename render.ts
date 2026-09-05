/**
 * Pure rendering helpers: Markdown to Telegram HTML, size fitting, button packing, option stance.
 * Nothing here touches the network, the filesystem, or session state, so `test/render.test.mjs`
 * drives it directly instead of through the fake server.
 */

export const TELEGRAM_TEXT_MAX = 4096;
export const TRUNCATION_NOTE = "\n\n(truncated, full text at the terminal)";
export const BUTTON_TEXT_MAX = 60;

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

/**
 * Emoji, then the working folder, then whatever names the work. A session past the placeholder
 * palette carries no emoji rather than a duplicate, so the leading space goes with it.
 */
export function badgeLine(emoji: string, cwd: string, detail: string, fallback: string): string {
	const folder =
		cwd
			.split("/")
			.filter((part) => part.length > 0)
			.pop() ?? cwd;
	const head = emoji.length > 0 ? `${emoji} ` : "";
	return `${head}${folder} \u00B7 ${detail.length > 0 ? clip(detail, 60) : fallback}`;
}

/** Compact elapsed time for the usage footer. */
export function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`;
	return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Absolute wall-clock time, the text a client without the date_time entity falls back to. */
export function clockTime(when: number): string {
	const at = new Date(when);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * A stamp the phone renders relative to now ("4 minutes ago") and keeps current itself. The wire
 * text never changes, so a board compared by text is not rewritten every minute for it.
 */
export function relativeTime(when: number): string {
	return `<tg-time unix="${Math.floor(when / 1000)}" format="r">${clockTime(when)}</tg-time>`;
}

/**
 * A fence long enough to carry `text` verbatim. A fence closes on a run at least as long as the
 * one that opened it, so a payload holding its own fence needs a longer one around it.
 */
export function fenceFor(text: string): string {
	let longest = 0;
	for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Markdown subset to Telegram HTML. Code is stashed first so emphasis cannot touch it, and so is
 * Telegram's own `tg-time` tag, the one piece of HTML the source may carry.
 */
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
		// The closer is a whole run at least as long as the opener, so a fenced payload can hold a
		// shorter fence, an opener is never read as part of a longer run, and no backtick is left over.
		.replace(
			/(?<!`)(`{3,})(?!`)([A-Za-z0-9_+-]*)\n?([\s\S]*?)\1`*(?!`)/g,
			(_match, _fence: string, language: string, code: string) => {
				const opener = language.length > 0 ? `<pre><code class="language-${language}">` : "<pre>";
				const closer = language.length > 0 ? "</code></pre>" : "</pre>";
				return stash(`${opener}${escapeHtml(code.replace(/\n$/, ""))}${closer}`);
			},
		);
	work = work.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));
	work = work.replace(
		/<tg-time unix="(\d+)"(?: format="([A-Za-z]*)")?>([^<\n]*)<\/tg-time>/g,
		(_match, unix: string, format: string | undefined, text: string) =>
			stash(
				`<tg-time unix="${unix}"${format === undefined ? "" : ` format="${format}"`}>${escapeHtml(text)}</tg-time>`,
			),
	);

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
 * A lukewarm button has no colour of its own, so the marker outranks the tail of a long label.
 */
export function buttonText(label: string, marker = ""): string {
	return `${clip(label, Math.max(0, BUTTON_TEXT_MAX - marker.length))}${marker}`;
}

/**
 * Telegram's 4096 applies to the text after its entities are parsed, verified against the live
 * API: HTML tags and escapes such as `&lt;` cost nothing, and the limit counts code points, so a
 * message of 4096 emoji goes through. The markdown source is therefore the budget, and measuring
 * it in UTF-16 units leaves the fit a little conservative in both directions rather than wrong.
 * `keep` is a short tail, today the usage footer, that survives the cut.
 */
export function fitToTelegram(plain: string, keep: string): string {
	const whole = plain + keep;
	if (whole.length <= TELEGRAM_TEXT_MAX) return dropLoneHighSurrogate(whole);
	const build = (n: number): string => {
		let head = dropLoneHighSurrogate(plain.slice(0, n).trimEnd());
		// An odd fence count means the cut landed inside a code block, which would otherwise
		// degrade to literal backticks for the whole remaining message.
		if ((head.match(/```/g)?.length ?? 0) % 2 === 1) head += "\n```";
		// A cut inside a time stamp would ship its tag as literal text.
		const stamp = head.lastIndexOf("<tg-time");
		if (stamp >= 0 && !head.includes("</tg-time>", stamp)) head = head.slice(0, stamp).trimEnd();
		return `${head}${TRUNCATION_NOTE}${keep}`;
	};
	let low = 0;
	let high = plain.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (build(mid).length <= TELEGRAM_TEXT_MAX) low = mid;
		else high = mid - 1;
	}
	return build(low);
}

/**
 * Telegram's phrase for a text-entity failure, which is the only refusal that plain text can fix.
 * A complaint about the keyboard also says "parse" and may name a tag, but the plain retry keeps
 * the same keyboard, so re-sending would repeat the identical malformed request.
 */
export function isMarkupFailure(description: string): boolean {
	const said = description.toLowerCase();
	return said.includes("can't parse entities") || said.includes("can't parse message text");
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
