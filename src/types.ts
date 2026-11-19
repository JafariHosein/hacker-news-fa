/**
 * Shared domain types.
 */

export interface Env {
  /** KV namespace used for the init timestamp and 30-day deduplication. */
  HN_KV: KVNamespace;

  // Secrets — set with `wrangler secret put` in production.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  GEMINI_API_KEY: string;
  TRIGGER_SECRET: string;

  // Plain variables — set in wrangler.toml. All are optional so the code can
  // fall back to safe defaults if one is omitted.
  GEMINI_MODEL?: string;
  MIN_SCORE?: string;
  MAX_POSTS_PER_RUN?: string;
  MAX_STORIES_TO_SCAN?: string;
  MAX_COMMENTS?: string;
  TELEGRAM_CHANNEL_HANDLE?: string;
  GEMINI_THINKING_BUDGET?: string;
}

/** A Hacker News item, as returned by the official Firebase API. */
export interface HNItem {
  id: number;
  deleted?: boolean;
  type?: "job" | "story" | "comment" | "poll" | "pollopt";
  by?: string;
  time?: number;
  text?: string;
  dead?: boolean;
  parent?: number;
  poll?: number;
  kids?: number[];
  url?: string;
  score?: number;
  title?: string;
  parts?: number[];
  descendants?: number;
}

/** The structured output requested from Gemini. */
export interface StorySummary {
  title_fa: string;
  summary_fa: string;
  hashtags: string[];
}

/** Runtime configuration resolved from environment variables. */
export interface RunConfig {
  model: string;
  minScore: number;
  maxPostsPerRun: number;
  maxStoriesToScan: number;
  maxComments: number;
  thinkingBudget: number;
}

export type RunTrigger = "cron" | "http";

export interface RunOptions {
  trigger: RunTrigger;
  /** Summarize without posting or writing dedup keys. */
  dryRun?: boolean;
  /** Debug-only override for MAX_POSTS_PER_RUN (capped at 5). */
  maxPosts?: number;
}

/** Where the text sent to Gemini came from. */
export type ContentSource = "article" | "comments" | "selftext";

export interface StoryResult {
  id: number;
  title: string;
  score: number;
  hnUrl: string;
  status: "posted" | "preview" | "error";
  source?: ContentSource;
  messageId?: number;
  /** Non-fatal problem, e.g. the post was sent but the dedup key was not saved. */
  warning?: string;
  error?: string;
  /** Rendered Telegram HTML, only present for dry runs. */
  preview?: string;
}

export type StopReason =
  | "post_limit"
  | "subrequest_budget"
  | "time_limit"
  | "too_many_errors"
  | "candidates_exhausted";

export interface PipelineResult {
  ok: boolean;
  trigger: RunTrigger;
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  initTimestamp: number;
  scanned: number;
  eligible: number;
  duplicatesSkipped: number;
  posted: number;
  stoppedReason: StopReason;
  budget: { used: number; max: number };
  results: StoryResult[];
  errors: string[];
}
