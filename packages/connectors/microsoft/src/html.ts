/**
 * Minimal HTML → plain text for mail bodies. Graph is asked for text bodies
 * (`Prefer: outlook.body-content-type="text"`), so this is the fallback for
 * the cases where Graph still returns HTML. Regex-based on purpose: no DOM in
 * Edge Functions, and context needs readable text, not fidelity.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * The rest of a tag after its name: attribute soup where a quoted value may
 * contain `>` (`title="x > y"`, tracking URLs), so a bare `[^>]*` would cut the
 * tag short and leak `y">` into the text. Nothing here may cross a `<`: a
 * quoted value that never closes (`alt="oops>`) or an apostrophe in an unquoted
 * value (`class=don't`) must not swallow the rest of the mail, and a scan that
 * cannot pass the next `<` stays linear on bodies made of tag starts. Tags this
 * grammar rejects are stripped by the residue pass below instead of leaking.
 */
const ATTRS = `[^<>"']*(?:(?:"[^"<]*"|'[^'<]*')[^<>"']*)*`;
const CELL_START = new RegExp(`<(td|th)\\b${ATTRS}>`, "gi");
const ANY_TAG = new RegExp(`</?[a-zA-Z!?]${ATTRS}>`, "g");
/** Whatever the attribute grammar rejected: strip it rather than leak markup, without crossing another `<`. A `<` not followed by a tag name is text (`1 < 2`). */
const RESIDUE_TAG = /<\/?[a-zA-Z!?][^<>]*>/g;
const BLOCK_START = /<(script|style|head|title)\b/gi;
/**
 * Bodies are truncated to MAX_BODY_CHARS of text afterwards; this bounds the
 * markup that is scanned to get there, so one hostile message cannot stall a
 * sync run.
 */
export const MAX_HTML_CHARS = 256_000;

/** Drops script/style/head/title blocks with their contents in one linear pass (a lazy regex re-scanned to the end for every unclosed start). */
function dropBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let pos = 0;
  BLOCK_START.lastIndex = 0;
  for (let m = BLOCK_START.exec(html); m; m = BLOCK_START.exec(html)) {
    out += html.slice(pos, m.index);
    const close = lower.indexOf(`</${(m[1] as string).toLowerCase()}`, m.index + m[0].length);
    if (close === -1) return out; // unclosed: the rest is the block
    const end = html.indexOf(">", close);
    pos = end === -1 ? html.length : end + 1;
    BLOCK_START.lastIndex = pos;
  }
  return out + html.slice(pos);
}

export function htmlToText(html: string): string {
  const bounded = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const text = dropBlocks(bounded.replace(/<!--[\s\S]*?-->/g, ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer)\s*>/gi, "\n")
    .replace(CELL_START, " ")
    .replace(ANY_TAG, "")
    .replace(RESIDUE_TAG, "");
  return decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
