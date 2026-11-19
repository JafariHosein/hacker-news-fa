/**
 * Small shared helpers. No Node.js APIs are used, so everything here runs on
 * the standard Workers runtime.
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; HN-Fa-Bot/1.0)";

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Tracks outbound fetch calls so a single invocation never gets close to
 * Cloudflare's free-tier limit of 50 subrequests.
 */
export class SubrequestBudget {
  private used = 0;

  constructor(readonly max: number) {}

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  get usage(): { used: number; max: number } {
    return { used: this.used, max: this.max };
  }

  take(label: string): void {
    if (this.used >= this.max) {
      throw new BudgetExhaustedError(label);
    }
    this.used += 1;
  }
}

export class BudgetExhaustedError extends Error {
  constructor(label: string) {
    super(`Subrequest budget exhausted before "${label}"`);
    this.name = "BudgetExhaustedError";
  }
}

export interface RequestContext {
  budget: SubrequestBudget;
  fetchImpl: typeof fetch;
}

export function createRequestContext(maxSubrequests: number): RequestContext {
  return {
    budget: new SubrequestBudget(maxSubrequests),
    // Keep fetch bound to the global scope. Calling a stored reference as
    // `ctx.fetchImpl(...)` changes `this` and workerd throws an
    // "Illegal invocation" error.
    fetchImpl: (input, init) => globalThis.fetch(input, init),
  };
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  label?: string;
  /** Maximum redirect hops. Every hop is charged to the subrequest budget. */
  maxRedirects?: number;
  /** Return false to reject a redirect target (for example, a private IP). */
  validateRedirect?: (url: string) => boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch + a hard timeout + subrequest accounting. Redirects are followed
 * manually because Cloudflare bills every redirect hop as a separate
 * subrequest; leaving `redirect: "follow"` in place would let an
 * attacker-controlled page exceed the 50-subrequest limit while the local
 * counter still reported a safe number. Manual hops also let callers
 * re-validate each new URL.
 */
export async function httpRequest(
  url: string,
  ctx: RequestContext,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = "request",
    maxRedirects = 4,
    validateRedirect,
  } = options;

  const requestHeaders = { "user-agent": USER_AGENT, ...headers };
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (let hop = 0; ; hop += 1) {
    ctx.budget.take(label);

    const init: RequestInit = {
      method: currentMethod,
      headers: requestHeaders,
      redirect: "manual",
      signal,
    };
    if (currentBody !== undefined) {
      init.body = currentBody;
    }

    const response = await ctx.fetchImpl(currentUrl, init);

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (hop >= maxRedirects) {
      await cancelBody(response);
      throw new Error(`Too many redirects while fetching "${label}"`);
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      await cancelBody(response);
      throw new Error(`Invalid redirect location while fetching "${label}"`);
    }

    if (validateRedirect && !validateRedirect(nextUrl)) {
      await cancelBody(response);
      throw new Error(`Blocked redirect to a disallowed URL while fetching "${label}"`);
    }

    // 303 always becomes GET. 301/302 do the same for POST, per the fetch
    // standard; 307/308 preserve the method and body.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        currentMethod.toUpperCase() === "POST")
    ) {
      currentMethod = "GET";
      currentBody = undefined;
    }

    await cancelBody(response);
    currentUrl = nextUrl;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A redirect body is irrelevant; failing to cancel it is not fatal.
  }
}

/** True only for absolute http(s) URLs that are safe to put in a link. */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape a value placed inside an HTML attribute. */
export function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

/** Turn an unknown thrown value into a readable, log-safe message. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Parse an integer environment variable, clamping it to a safe range. */
export function intFromEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Truncate at a word boundary when possible and add an ellipsis. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare two secrets without leaking timing information on content. */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;

  let difference = 0;
  for (let index = 0; index < aBytes.byteLength; index += 1) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Run an async mapper over a list with bounded concurrency, preserving order.
 * Workers allow only a handful of simultaneous outbound connections, so this
 * is both faster and safer than unbounded Promise.all.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await mapper(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
