/**
 * Minimal client for the official Hacker News Firebase API.
 * Docs: https://github.com/HackerNews/API
 */

import type { HNItem } from "./types";
import {
  BudgetExhaustedError,
  getErrorMessage,
  httpRequest,
  mapLimit,
  type RequestContext,
} from "./utils";

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";
const HN_TIMEOUT_MS = 8_000;

/** Fetch the current top story ids, ordered by Hacker News' own ranking. */
export async function fetchTopStoryIds(ctx: RequestContext): Promise<number[]> {
  const response = await httpRequest(`${HN_API_BASE}/topstories.json`, ctx, {
    timeoutMs: HN_TIMEOUT_MS,
    label: "HN topstories",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`HN topstories returned HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("HN topstories response was not an array");
  }

  return data.filter(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

/**
 * Fetch one item. Individual failures are logged and converted to `null` so a
 * single deleted/unavailable item cannot abort an entire run.
 */
export async function fetchItem(
  id: number,
  ctx: RequestContext,
): Promise<HNItem | null> {
  try {
    const response = await httpRequest(`${HN_API_BASE}/item/${id}.json`, ctx, {
      timeoutMs: HN_TIMEOUT_MS,
      label: "HN item",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      console.warn(
        JSON.stringify({ event: "hn_item_http_error", id, status: response.status }),
      );
      return null;
    }

    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return null;
    return data as HNItem;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    console.warn(
      JSON.stringify({
        event: "hn_item_fetch_error",
        id,
        error: getErrorMessage(error),
      }),
    );
    return null;
  }
}

/**
 * Fetch up to `limit` top-level comments for use as summarization context.
 * The caller is responsible for reserving subrequest budget first.
 */
export async function fetchTopComments(
  kids: readonly number[],
  limit: number,
  ctx: RequestContext,
): Promise<HNItem[]> {
  const ids = kids.slice(0, Math.max(0, limit));
  if (ids.length === 0) return [];

  const items = await mapLimit(ids, 4, (id) => fetchItem(id, ctx));

  return items.filter(
    (item): item is HNItem =>
      item !== null &&
      item.type === "comment" &&
      !item.deleted &&
      !item.dead &&
      typeof item.text === "string" &&
      item.text.trim().length > 0,
  );
}
