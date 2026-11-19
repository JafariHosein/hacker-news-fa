/**
 * The ingestion → summarization → Telegram pipeline.
 */

import { summarizeStory } from "./gemini";
import { fetchItem, fetchTopComments, fetchTopStoryIds } from "./hn";
import { fetchArticleText, htmlToText, isScrapableUrl } from "./scraper";
import { buildTelegramMessage, sendTelegramMessage } from "./telegram";
import type {
  ContentSource,
  Env,
  HNItem,
  PipelineResult,
  RunConfig,
  RunOptions,
  StopReason,
  StoryResult,
} from "./types";
import {
  BudgetExhaustedError,
  createRequestContext,
  getErrorMessage,
  intFromEnv,
  mapLimit,
  truncate,
  type RequestContext,
} from "./utils";

/** Stay comfortably below Cloudflare's 50-subrequest free-tier limit. */
const MAX_SUBREQUESTS = 45;
const MAX_RUN_MS = 45_000;
const MIN_BUDGET_PER_STORY = 3;
/** Stop when this many stories fail back-to-back (e.g. a bad API key). */
const MAX_CONSECUTIVE_FAILURES = 3;
const HN_ITEM_CONCURRENCY = 6;
const INIT_KEY = "bot_init_timestamp";
const SEEN_TTL_SECONDS = 2_592_000; // 30 days
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

interface CandidateStory extends HNItem {
  title: string;
  score: number;
  time: number;
}

interface StoryContext {
  text: string;
  source: ContentSource;
}

/**
 * A story with no usable text is a per-story quality problem, not evidence
 * that Gemini or Telegram is down. It must not trip the consecutive-failure
 * circuit breaker.
 */
class StoryContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryContentError";
  }
}

function hnDiscussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/** Resolve non-secret configuration, always returning valid values. */
export function loadConfig(env: Env): RunConfig {
  return {
    model: env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
    minScore: intFromEnv(env.MIN_SCORE, 100, 0, 100_000),
    maxPostsPerRun: intFromEnv(env.MAX_POSTS_PER_RUN, 2, 1, 10),
    maxStoriesToScan: intFromEnv(env.MAX_STORIES_TO_SCAN, 30, 1, 30),
    maxComments: intFromEnv(env.MAX_COMMENTS, 5, 0, 10),
    thinkingBudget: intFromEnv(env.GEMINI_THINKING_BUDGET, 0, 0, 24_576),
  };
}

/**
 * Read (or initialize) the deployment timestamp. Stories submitted before the
 * bot existed are intentionally ignored so the channel starts with fresh news.
 * KV is eventually consistent; the timestamp is harmless if a concurrent first
 * run races with this one.
 */
export async function ensureInitTimestamp(kv: KVNamespace): Promise<number> {
  const existing = await kv.get(INIT_KEY);
  if (existing !== null) {
    const parsed = Number.parseInt(existing, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const now = Math.floor(Date.now() / 1_000);
  await kv.put(INIT_KEY, String(now));
  return now;
}

function isCandidateStory(
  item: HNItem | null,
  minScore: number,
  initTimestamp: number,
): item is CandidateStory {
  return (
    item !== null &&
    item.type === "story" &&
    !item.deleted &&
    !item.dead &&
    typeof item.title === "string" &&
    item.title.trim().length > 0 &&
    typeof item.score === "number" &&
    item.score >= minScore &&
    typeof item.time === "number" &&
    item.time >= initTimestamp
  );
}

async function hasSeen(kv: KVNamespace, id: number): Promise<boolean> {
  try {
    return (await kv.get(`seen:${id}`)) !== null;
  } catch (error) {
    // A dedup read failure should not block the whole run; the post is only
    // duplicated in the unlikely event that the KV read failed and the story
    // was already sent.
    console.warn(
      JSON.stringify({
        event: "dedup_read_failed",
        storyId: id,
        error: getErrorMessage(error),
      }),
    );
    return false;
  }
}

/**
 * Prefer the article body. On any failure (paywall, timeout, 403, binary file,
 * too little text) fall back to the Ask/Show HN self text plus the top comments.
 */
async function buildStoryContext(
  story: CandidateStory,
  config: RunConfig,
  ctx: RequestContext,
  budgetReserve: number,
): Promise<StoryContext> {
  const selfText = story.text ? htmlToText(story.text) : "";

  if (story.url && isScrapableUrl(story.url)) {
    try {
      const articleText = await fetchArticleText(story.url, ctx);
      if (articleText) {
        return { text: articleText, source: "article" };
      }
      console.warn(
        JSON.stringify({ event: "article_no_readable_text", storyId: story.id }),
      );
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      console.warn(
        JSON.stringify({
          event: "article_fetch_failed",
          storyId: story.id,
          error: getErrorMessage(error),
        }),
      );
    }
  }

  // Keep enough budget for Gemini (and Telegram unless this is a dry run).
  const commentSlots = Math.max(
    0,
    Math.min(config.maxComments, ctx.budget.remaining - budgetReserve),
  );

  const comments =
    story.kids && story.kids.length > 0 && commentSlots > 0
      ? await fetchTopComments(story.kids, commentSlots, ctx)
      : [];

  const commentBlocks = comments
    .map((comment) => {
      const body = truncate(htmlToText(comment.text ?? ""), 1_200);
      if (!body) return "";
      const author = comment.by ? `@${comment.by}: ` : "";
      return `${author}${body}`;
    })
    .filter((block) => block.length > 0);

  const parts: string[] = [];
  if (selfText) parts.push(selfText);
  if (commentBlocks.length > 0) parts.push(commentBlocks.join("\n\n---\n\n"));

  const text = truncate(parts.join("\n\n"), 6_000).trim();
  if (text.length < 80) {
    throw new StoryContentError("No usable article text or comments found");
  }

  return {
    text,
    source: commentBlocks.length > 0 ? "comments" : "selftext",
  };
}

/**
 * Run one complete pass. Per-story failures are captured in the result instead
 * of aborting the run; only configuration or fatal upstream failures throw.
 */
export async function runPipeline(
  env: Env,
  options: RunOptions,
): Promise<PipelineResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const dryRun = options.dryRun === true;
  const config = loadConfig(env);
  const maxPosts = options.maxPosts
    ? Math.min(5, Math.max(1, Math.trunc(options.maxPosts)))
    : config.maxPostsPerRun;

  if (!env.HN_KV) {
    throw new Error("HN_KV binding is not configured");
  }
  if (!env.GEMINI_API_KEY?.trim()) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  if (!dryRun) {
    if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    }
    if (!env.TELEGRAM_CHANNEL_ID?.trim()) {
      throw new Error("TELEGRAM_CHANNEL_ID is not configured");
    }
  }

  const ctx = createRequestContext(MAX_SUBREQUESTS);
  const initTimestamp = await ensureInitTimestamp(env.HN_KV);

  const topIds = await fetchTopStoryIds(ctx);
  const scannedIds = topIds.slice(0, config.maxStoriesToScan);

  // Deduplicate before fetching items. KV reads do not count as subrequests,
  // while every item fetch does. Skipping known stories here leaves enough
  // budget to look deeper into the ranking for fresh ones.
  const seenFlags = await Promise.all(
    scannedIds.map(async (id) => ({
      id,
      seen: await hasSeen(env.HN_KV, id),
    })),
  );
  const seenIds = new Set(
    seenFlags.filter((entry) => entry.seen).map((entry) => entry.id),
  );
  const unseenIds = scannedIds.filter((id) => !seenIds.has(id));

  const items = await mapLimit(unseenIds, HN_ITEM_CONCURRENCY, (id) =>
    fetchItem(id, ctx),
  );

  const candidates = items.filter((item): item is CandidateStory =>
    isCandidateStory(item, config.minScore, initTimestamp),
  );

  const results: StoryResult[] = [];
  const errors: string[] = [];
  let posted = 0;
  let selected = 0; // successful posts plus dry-run previews
  let consecutiveFailures = 0;
  let stoppedReason: StopReason = "candidates_exhausted";

  for (const story of candidates) {
    if (selected >= maxPosts) {
      stoppedReason = "post_limit";
      break;
    }
    if (ctx.budget.remaining < MIN_BUDGET_PER_STORY) {
      stoppedReason = "subrequest_budget";
      break;
    }
    if (Date.now() - startedMs > MAX_RUN_MS) {
      stoppedReason = "time_limit";
      break;
    }

    const base = {
      id: story.id,
      title: story.title,
      score: story.score,
      hnUrl: hnDiscussionUrl(story.id),
    };

    try {
      const context = await buildStoryContext(
        story,
        config,
        ctx,
        dryRun ? 1 : 2,
      );
      const summary = await summarizeStory(
        story,
        context.text,
        context.source,
        config,
        env.GEMINI_API_KEY,
        ctx,
      );
      const message = buildTelegramMessage(
        story,
        summary,
        env.TELEGRAM_CHANNEL_HANDLE,
      );

      if (dryRun) {
        results.push({
          ...base,
          status: "preview",
          source: context.source,
          preview: message,
        });
        selected += 1;
        consecutiveFailures = 0;
        continue;
      }

      const sent = await sendTelegramMessage(env, message, ctx);

      let warning: string | undefined;
      try {
        await env.HN_KV.put(`seen:${story.id}`, "1", {
          expirationTtl: SEEN_TTL_SECONDS,
        });
      } catch (error) {
        warning = `Posted, but failed to save the dedup key: ${getErrorMessage(error)}`;
        errors.push(`Story ${story.id}: ${warning}`);
        console.error(
          JSON.stringify({
            event: "dedup_write_failed",
            storyId: story.id,
            error: getErrorMessage(error),
          }),
        );
      }

      results.push({
        ...base,
        status: "posted",
        source: context.source,
        messageId: sent.messageId,
        warning,
      });
      posted += 1;
      selected += 1;
      consecutiveFailures = 0;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      results.push({ ...base, status: "error", error: errorMessage });
      errors.push(`Story ${story.id}: ${errorMessage}`);
      if (error instanceof StoryContentError) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
      console.error(
        JSON.stringify({
          event: "story_failed",
          storyId: story.id,
          error: errorMessage,
        }),
      );

      if (error instanceof BudgetExhaustedError) {
        stoppedReason = "subrequest_budget";
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Likely a systemic problem (invalid key, provider outage). Stop
        // instead of spending the whole subrequest budget on doomed calls.
        stoppedReason = "too_many_errors";
        console.error(
          JSON.stringify({
            event: "run_stopped_after_consecutive_failures",
            failures: consecutiveFailures,
          }),
        );
        break;
      }
    }
  }

  if (selected >= maxPosts) {
    stoppedReason = "post_limit";
  }

  const result: PipelineResult = {
    ok: errors.length === 0,
    trigger: options.trigger,
    dryRun,
    startedAt,
    durationMs: Date.now() - startedMs,
    initTimestamp,
    scanned: scannedIds.length,
    eligible: candidates.length,
    duplicatesSkipped: seenIds.size,
    posted,
    stoppedReason,
    budget: ctx.budget.usage,
    results,
    errors,
  };

  console.log(
    JSON.stringify({
      event: "run_complete",
      ...result,
      results: result.results.map((item) => ({
        ...item,
        preview: item.preview ? "[omitted]" : undefined,
      })),
    }),
  );

  return result;
}
