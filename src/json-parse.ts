/**
 * Tolerant extraction of JSON from an LLM chat completion.
 *
 * Models are asked for JSON in plain prose, so the reply is not guaranteed to be
 * a bare JSON document. This module recovers the payload from the shapes that
 * show up in practice:
 *   - JSON wrapped in a ```json markdown fence, or surrounded by explanatory text
 *   - several top level objects instead of one array ("{...}\n{...}")
 *   - LaTeX and Windows paths inside strings ("\sqrt{2}"), which are invalid
 *     JSON escapes and also break naive brace counting
 *   - literal newlines and control characters inside strings
 *   - trailing commas
 *   - a response cut short by the token limit
 *
 * Valid JSON escapes are always left untouched, so "\\n" in the reply stays a
 * backslash followed by "n" and "é" stays an é. The one case that stays
 * ambiguous is an unescaped LaTeX macro whose name starts with n, r, t or u
 * ("\times", "\neq"): those collide with the newline, tab and unicode escapes,
 * which are common and intentional, so JSON wins and the macro is read as the
 * escape. Everything else, "\sqrt{2}" included, survives as written.
 */

const VALID_ESCAPES = '"\\/bfnrt';

// \f and \b are legal JSON escapes, but in an LLM reply "\frac", "\beta" and
// "\forall" are LaTeX far more often than a formfeed or a backspace, neither of
// which has any meaning in note text. A letter after the escape is the tell.
const LATEX_ESCAPES = '"\\/nrt';
const LATEX_COLLISION = /\\[fb][A-Za-z]/;

type ParseResult = { ok: true; value: unknown } | { ok: false };

const FAILED: ParseResult = { ok: false };

export class LlmJsonError extends Error {
	readonly raw: string;

	constructor(message: string, raw: string) {
		super(message);
		this.name = "LlmJsonError";
		this.raw = raw;
	}
}

/**
 * Returns every JSON value found in `raw`, flattened into a single array.
 * Throws LlmJsonError when nothing parseable is left.
 */
export function extractJsonArray(raw: string): unknown[] {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new LlmJsonError("LLM returned an empty response", raw ?? "");
	}

	const text = stripInvisible(raw);
	let values = collectJsonValues(text);

	if (values.length === 0) {
		// Nothing balanced in the text: the reply was probably truncated.
		const salvaged = salvageTruncated(text);
		if (salvaged.ok) {
			values = [salvaged.value];
		}
	}

	if (values.length === 0) {
		throw new LlmJsonError("No JSON value found in LLM response", raw);
	}

	return flatten(values);
}

/**
 * Walks the text and parses every balanced `{...}` / `[...]` run it can.
 * A run that will not parse is skipped one character at a time instead of
 * being jumped over, so a stray brace in the prose cannot hide the real
 * payload that follows it.
 */
function collectJsonValues(text: string): unknown[] {
	const values: unknown[] = [];
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		if (char !== "{" && char !== "[") {
			i++;
			continue;
		}

		const end = findValueEnd(text, i);
		if (end === -1) {
			i++;
			continue;
		}

		const result = parseWithRepairs(text.slice(i, end));
		if (result.ok) {
			values.push(result.value);
			i = end;
		} else {
			i++;
		}
	}

	return values;
}

/**
 * Index just past the value that starts at `start`, or -1 if it never closes.
 * String aware, so braces inside "\sqrt{2}" do not affect the nesting depth.
 */
function findValueEnd(text: string, start: number): number {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
		} else if (char === "{" || char === "[") {
			stack.push(char === "{" ? "}" : "]");
		} else if (char === "}" || char === "]") {
			if (stack.pop() !== char) {
				return -1;
			}
			if (stack.length === 0) {
				return i + 1;
			}
		}
	}

	return -1;
}

function parseWithRepairs(candidate: string): ParseResult {
	const latex = LATEX_COLLISION.test(candidate);

	// Skipped when \f or \b would swallow a LaTeX macro: that parses cleanly but
	// gives back a control character, so the repaired reading is the better one.
	if (!latex) {
		const direct = tryParse(candidate);
		if (direct.ok) {
			return direct;
		}
	}

	const repaired = tryParse(stripTrailingCommas(escapeStringContents(candidate, latex)));
	if (repaired.ok) {
		return repaired;
	}

	return latex ? tryParse(candidate) : FAILED;
}

function tryParse(candidate: string): ParseResult {
	try {
		return { ok: true, value: JSON.parse(candidate) };
	} catch (error) {
		return FAILED;
	}
}

/**
 * Escapes what JSON forbids inside strings: lone backslashes (LaTeX, Windows
 * paths) and raw control characters. Sequences that are already valid escapes
 * are copied through unchanged so nothing gets double escaped.
 */
function escapeStringContents(text: string, latex = false): string {
	const valid = latex ? LATEX_ESCAPES : VALID_ESCAPES;
	let out = "";
	let inString = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (!inString) {
			out += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			out += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const next = text[i + 1];
			if (next === undefined) {
				out += "\\\\";
			} else if (valid.includes(next)) {
				out += char + next;
				i++;
			} else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
				out += text.slice(i, i + 6);
				i += 5;
			} else {
				out += "\\\\";
			}
			continue;
		}

		if (char === "\n") {
			out += "\\n";
		} else if (char === "\r") {
			out += "\\r";
		} else if (char === "\t") {
			out += "\\t";
		} else if (char < " ") {
			out += "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
		} else {
			out += char;
		}
	}

	return out;
}

function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			out += char;
			if (char === "\\") {
				out += text[i + 1] ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			out += char;
			inString = true;
			continue;
		}

		if (char === "," && /^\s*[}\]]/.test(text.slice(i + 1))) {
			continue;
		}

		out += char;
	}

	return out;
}

/**
 * Last resort for a reply that hit the token limit: close the open string and
 * brackets, and if that still will not parse, drop the unfinished element.
 */
function salvageTruncated(text: string): ParseResult {
	const start = firstBracket(text);
	if (start === -1) {
		return FAILED;
	}

	const body = stripTrailingCommas(escapeStringContents(text.slice(start)));
	const state = scanState(body);
	if (state.stack.length === 0) {
		return FAILED;
	}

	const closed = (state.inString ? body + '"' : body) + closers(state.stack);
	const direct = tryParse(stripTrailingCommas(closed));
	if (direct.ok) {
		return direct;
	}

	// Cut back to the last completed element and close again.
	const cut = state.lastElementEnd;
	if (cut === -1) {
		return FAILED;
	}
	const truncated = body.slice(0, cut);
	return tryParse(truncated + closers(scanState(truncated).stack));
}

function scanState(text: string): { stack: string[]; inString: boolean; lastElementEnd: number } {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	let lastElementEnd = -1;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
		} else if (char === "{" || char === "[") {
			stack.push(char === "{" ? "}" : "]");
		} else if (char === "}" || char === "]") {
			stack.pop();
			if (stack.length === 1) {
				lastElementEnd = i + 1;
			}
		}
	}

	return { stack, inString, lastElementEnd };
}

function closers(stack: string[]): string {
	return stack.slice().reverse().join("");
}

function firstBracket(text: string): number {
	const object = text.indexOf("{");
	const array = text.indexOf("[");
	if (object === -1) return array;
	if (array === -1) return object;
	return Math.min(object, array);
}

/**
 * Arrays are spread into the result, and a wrapper object whose only value is
 * an array ({"notes": [...]}) is unwrapped. Everything else is kept as is.
 */
function flatten(values: unknown[]): unknown[] {
	const out: unknown[] = [];

	for (const value of values) {
		if (Array.isArray(value)) {
			out.push(...value);
			continue;
		}

		const unwrapped = unwrapContainer(value);
		if (unwrapped) {
			out.push(...unwrapped);
		} else {
			out.push(value);
		}
	}

	return out;
}

function unwrapContainer(value: unknown): unknown[] | null {
	if (!isPlainObject(value)) {
		return null;
	}
	const entries = Object.values(value);
	if (entries.length === 1 && Array.isArray(entries[0])) {
		return entries[0];
	}
	return null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripInvisible(text: string): string {
	// BOM and zero width characters models occasionally emit around the payload.
	return text.replace(/[\uFEFF\u200B-\u200D]/g, "").trim();
}
