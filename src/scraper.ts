/**
 * Lightweight article extraction. This deliberately avoids DOM parsers and
 * heavy readability libraries to stay fast and small on the Workers runtime.
 */

import { httpRequest, truncate, type RequestContext } from "./utils";

const ARTICLE_TIMEOUT_MS = 5_000;
const MIN_ARTICLE_CHARS = 200;
const MAX_CONTENT_CHARS = 6_000;
const MAX_HTML_CHARS = 200_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_DOWNLOAD_BYTES = 750_000;

const NON_ARTICLE_EXTENSIONS = new Set([
  "7z",
  "apk",
  "avi",
  "bmp",
  "bz2",
  "csv",
  "dmg",
  "doc",
  "docx",
  "eot",
  "exe",
  "flac",
  "gif",
  "gz",
  "ico",
  "iso",
  "jpeg",
  "jpg",
  "m4a",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "otf",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "rar",
  "svg",
  "tar",
  "tgz",
  "tiff",
  "ttf",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "xz",
  "zip",
]);

const BINARY_CONTENT_TYPE =
  /^(?:image|audio|video)\/|^application\/(?:pdf|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|octet-stream|msword|vnd\.)/i;

const BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose entire content (not just the tag) must be ignored. */
const SKIP_CONTENT_TAGS = new Set([
  "aside",
  "button",
  "embed",
  "footer",
  "form",
  "header",
  "iframe",
  "nav",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  ccedil: "ç",
  cent: "¢",
  copy: "©",
  deg: "°",
  divide: "÷",
  dagger: "†",
  eacute: "é",
  egrave: "è",
  euro: "€",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  micro: "µ",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  ntilde: "ñ",
  para: "¶",
  plusmn: "±",
  pound: "£",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  sect: "§",
  szlig: "ß",
  times: "×",
  trade: "™",
  uuml: "ü",
  yen: "¥",
  zwnj: "\u200c",
  zwj: "\u200d",
};

/**
 * True for normal http(s) pages; false for PDFs, images, archives, private
 * addresses and other obviously non-article resources.
 */
export function isScrapableUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isPrivateHostname(parsed.hostname)) return false;

  const path = parsed.pathname.toLowerCase();
  const lastDot = path.lastIndexOf(".");
  if (lastDot !== -1) {
    const extension = path.slice(lastDot + 1);
    if (NON_ARTICLE_EXTENSIONS.has(extension)) return false;
  }

  return true;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** Reject localhost, private IP literals and common internal-only suffixes. */
function isPrivateHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    return true;
  }

  if (hostname.includes(":")) {
    // A trailing IPv4 literal can be embedded in an IPv4-mapped IPv6 address.
    const mapped = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
    if (mapped?.[1] && isPrivateIpv4(mapped[1])) return true;

    if (hostname === "::" || hostname === "::1") return true;
    const firstGroup = Number.parseInt(hostname.split(":")[0] || "0", 16);
    if (!Number.isFinite(firstGroup)) return false;
    if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((firstGroup & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
  }

  return isPrivateIpv4(hostname);
}

function codePointToString(code: number, fallback: string): string {
  if (
    !Number.isInteger(code) ||
    code <= 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return fallback;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Decode named and numeric HTML entities in a single pass. */
export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi,
    (match: string, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return codePointToString(Number.parseInt(entity.slice(2), 16), match);
      }
      if (entity.startsWith("#")) {
        return codePointToString(Number.parseInt(entity.slice(1), 10), match);
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v\u2007\u202f]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 45 || // -
    code === 58 // :
  );
}

interface ScannedText {
  /** Text from the whole document. */
  body: string;
  /** Text inside the first-level <article> or <main> element. */
  article: string;
}

/**
 * Linear single-pass HTML text scanner.
 *
 * Regex-based HTML cleanup is tempting, but lazy patterns such as
 * `<tag[^>]*>[\s\S]*?</tag>` are quadratic when a truncated page contains
 * thousands of unclosed tags. An attacker-controlled article URL could then
 * burn the whole Workers CPU budget. This scanner looks at every byte a
 * constant number of times, which keeps a 300 KB document in the low
 * milliseconds even when the markup is malformed.
 */
function scanHtml(html: string): ScannedText {
  const bodyParts: string[] = [];
  const articleParts: string[] = [];
  let articleDepth = 0;
  let skipTag = "";
  let skipDepth = 0;
  let textStart = 0;
  let index = 0;

  const appendText = (value: string): void => {
    if (!value) return;
    bodyParts.push(value);
    if (articleDepth > 0) articleParts.push(value);
  };

  const appendMarkup = (value: string): void => {
    bodyParts.push(value);
    if (articleDepth > 0) articleParts.push(value);
  };

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      if (skipDepth === 0) {
        if (lt > textStart) appendText(html.slice(textStart, lt));
        // A comment separates words, just like the whitespace it replaces.
        appendMarkup(" ");
      }
      const commentEnd = html.indexOf("-->", lt + 4);
      if (commentEnd === -1) {
        index = html.length;
        textStart = index;
        break;
      }
      index = commentEnd + 3;
      textStart = index;
      continue;
    }

    const marker = html.charCodeAt(lt + 1);
    if (marker === 33 /* ! */ || marker === 63 /* ? */) {
      if (skipDepth === 0 && lt > textStart) {
        appendText(html.slice(textStart, lt));
      }
      const declarationEnd = html.indexOf(">", lt + 2);
      if (declarationEnd === -1) {
        index = html.length;
        textStart = index;
        break;
      }
      index = declarationEnd + 1;
      textStart = index;
      continue;
    }

    const closing = marker === 47 /* / */;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isAsciiLetter(html.charCodeAt(nameStart))) {
      // Not a tag; keep the "<" as literal text.
      index = lt + 1;
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && isTagNameChar(html.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    // Find the end of the tag while respecting quoted attribute values.
    let cursor = nameEnd;
    let quote = 0;
    let tagEnd = -1;
    while (cursor < html.length) {
      const code = html.charCodeAt(cursor);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === 34 /* " */ || code === 39 /* ' */) {
        quote = code;
      } else if (code === 62 /* > */) {
        tagEnd = cursor;
        break;
      }
      cursor += 1;
    }
    if (tagEnd === -1) {
      // Truncated or hostile markup: scan the rest once and stop.
      index = html.length;
      textStart = index;
      break;
    }

    if (skipDepth === 0 && lt > textStart) {
      appendText(html.slice(textStart, lt));
    }

    index = tagEnd + 1;
    textStart = index;

    const selfClosing =
      html.charCodeAt(tagEnd - 1) === 47 /* / */ || VOID_TAGS.has(name);

    if (skipDepth > 0) {
      if (name === skipTag) {
        if (closing) skipDepth -= 1;
        else if (!selfClosing) skipDepth += 1;
        if (skipDepth === 0) skipTag = "";
      }
      continue;
    }

    if (SKIP_CONTENT_TAGS.has(name)) {
      if (!closing && !selfClosing) {
        skipTag = name;
        skipDepth = 1;
      }
      continue;
    }

    if (name === "article" || name === "main") {
      if (closing) {
        if (articleDepth > 0) appendMarkup("\n");
        articleDepth = Math.max(0, articleDepth - 1);
      } else {
        appendMarkup("\n");
        if (!selfClosing) articleDepth += 1;
      }
      continue;
    }

    if (name === "li") {
      appendMarkup(closing ? "\n" : "\n• ");
    } else if (name === "br") {
      appendMarkup("\n");
    } else if (BLOCK_TAGS.has(name)) {
      appendMarkup("\n");
    } else if (!closing) {
      // Preserve a word boundary for inline markup ("foo<span>bar</span>").
      appendMarkup(" ");
    }
  }

  if (skipDepth === 0 && textStart < html.length) {
    appendText(html.slice(textStart));
  }

  return {
    body: bodyParts.join(""),
    article: articleParts.join(""),
  };
}

/** Bound the amount of raw text decoded and normalized in one call. */
const MAX_RAW_TEXT_CHARS = MAX_TEXT_CHARS * 4;

function finalizeText(raw: string, maxChars: number, ellipsis: boolean): string {
  const limited =
    raw.length > MAX_RAW_TEXT_CHARS ? raw.slice(0, MAX_RAW_TEXT_CHARS) : raw;
  const normalized = normalizeText(decodeEntities(limited));
  if (normalized.length <= maxChars) return normalized;
  return ellipsis
    ? truncate(normalized, maxChars)
    : normalized.slice(0, maxChars).trimEnd();
}

/**
 * Convert an HTML fragment to readable plain text. Scripts, styles, navigation,
 * footers and all remaining tags are removed; block elements become newlines
 * and list items become bullets.
 */
export function htmlToText(html: string): string {
  const limited = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  return finalizeText(scanHtml(limited).body, MAX_TEXT_CHARS, false);
}

/**
 * Extract readable body text. Prefers a real <article> or <main> element, then
 * falls back to the whole document. Returns null when there is too little text
 * (paywall, JS-only page, bot challenge, etc.).
 */
export function extractArticleText(html: string): string | null {
  const limited = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const scanned = scanHtml(limited);

  const article = finalizeText(scanned.article, MAX_CONTENT_CHARS, true);
  if (article.length >= MIN_ARTICLE_CHARS) return article;

  const fallback = finalizeText(scanned.body, MAX_CONTENT_CHARS, true);
  if (fallback.length < MIN_ARTICLE_CHARS) return null;
  return fallback;
}

/** Read a response body while enforcing a hard byte limit. */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  contentType: string,
): Promise<string | null> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const charsetMatch = /charset=([^;]+)/i.exec(contentType);
  const charset = charsetMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Fetch and extract an article. Throws on network/HTTP failures so the caller
 * can fall back to Hacker News comments; returns null for binary resources or
 * pages without enough readable text.
 */
export async function fetchArticleText(
  url: string,
  ctx: RequestContext,
): Promise<string | null> {
  if (!isScrapableUrl(url)) return null;

  const response = await httpRequest(url, ctx, {
    timeoutMs: ARTICLE_TIMEOUT_MS,
    label: "article",
    maxRedirects: 3,
    // Re-check every hop so a public URL cannot redirect the Worker to a
    // private address or a non-article resource.
    validateRedirect: isScrapableUrl,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Article returned HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (BINARY_CONTENT_TYPE.test(contentType)) return null;

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    return null;
  }

  const html = await readBodyWithLimit(
    response,
    MAX_DOWNLOAD_BYTES,
    contentType,
  );
  if (!html) return null;

  return extractArticleText(html);
}
