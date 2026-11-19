/**
 * Telegram Bot API client and message formatting.
 */

import type { Env, HNItem, StorySummary } from "./types";
import {
  escapeAttr,
  escapeHtml,
  httpRequest,
  isHttpUrl,
  sleep,
  truncate,
  type RequestContext,
} from "./utils";

const TELEGRAM_MAX_LENGTH = 4_096;
const MAX_SUMMARY_CHARS = 1_800;
const MAX_URL_CHARS = 1_500;
const TELEGRAM_TIMEOUT_MS = 15_000;
const DEFAULT_CHANNEL_HANDLE = "@AutoHackerNewsFarsi";
const CHANNEL_HANDLE_PATTERN = /^[A-Za-z0-9_]{4,32}$/;

function hnDiscussionUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

function normalizeChannelHandle(value?: string): string {
  const raw = (value ?? DEFAULT_CHANNEL_HANDLE).trim();
  const username = raw.startsWith("@") ? raw.slice(1) : raw;
  return CHANNEL_HANDLE_PATTERN.test(username) ? `@${username}` : "";
}

function renderChannelFooter(handle?: string): string {
  const normalized = normalizeChannelHandle(handle);
  if (!normalized) return "";
  const url = `https://t.me/${normalized.slice(1)}`;
  return `📣 <a href="${escapeAttr(url)}">${escapeHtml(normalized)}</a>`;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

interface TelegramCall {
  httpOk: boolean;
  status: number;
  payload: TelegramApiResponse | null;
}

function renderMessage(
  story: Pick<HNItem, "id" | "url">,
  title: string,
  summaryText: string,
  hashtags: readonly string[],
  includeSource: boolean,
  channelHandle?: string,
): string {
  const blocks: string[] = [
    `<b>${escapeHtml(title)}</b>`,
    escapeHtml(summaryText),
  ];

  const links: string[] = [];
  if (includeSource && story.url) {
    links.push(`🔗 <a href="${escapeAttr(story.url)}">منبع اصلی</a>`);
  }
  links.push(
    `💬 <a href="${escapeAttr(hnDiscussionUrl(story.id))}">بحث و کامنت‌ها در Hacker News</a>`,
  );
  blocks.push(links.join("\n"));

  if (hashtags.length > 0) {
    blocks.push(hashtags.map((tag) => escapeHtml(tag)).join(" "));
  }

  const footer = renderChannelFooter(channelHandle);
  if (footer) blocks.push(footer);

  return blocks.join("\n\n");
}

/**
 * Build the final Telegram HTML. Summary length is trimmed when necessary so
 * the message always stays under Telegram's 4096-character limit without
 * cutting through an HTML tag or entity.
 */
export function buildTelegramMessage(
  story: Pick<HNItem, "id" | "url">,
  summary: StorySummary,
  channelHandle?: string,
): string {
  let summaryText = truncate(summary.summary_fa, MAX_SUMMARY_CHARS);
  let includeSource =
    typeof story.url === "string" &&
    story.url.length > 0 &&
    story.url.length <= MAX_URL_CHARS &&
    isHttpUrl(story.url);
  let hashtags = summary.hashtags.slice(0, 5);

  let message = renderMessage(
    story,
    summary.title_fa,
    summaryText,
    hashtags,
    includeSource,
    channelHandle,
  );

  for (let attempt = 0; attempt < 5 && message.length > TELEGRAM_MAX_LENGTH; attempt += 1) {
    if (summaryText.length > 200) {
      const overflow = message.length - TELEGRAM_MAX_LENGTH;
      summaryText = truncate(
        summaryText,
        Math.max(200, summaryText.length - overflow - 8),
      );
    } else if (includeSource) {
      includeSource = false;
    } else if (hashtags.length > 1) {
      hashtags = hashtags.slice(0, hashtags.length - 1);
    } else {
      break;
    }

    message = renderMessage(
      story,
      summary.title_fa,
      summaryText,
      hashtags,
      includeSource,
      channelHandle,
    );
  }

  if (message.length > TELEGRAM_MAX_LENGTH) {
    throw new Error("Telegram message exceeds the 4096-character limit");
  }

  return message;
}

async function callTelegram(
  botToken: string,
  channelId: string,
  text: string,
  ctx: RequestContext,
): Promise<TelegramCall> {
  const response = await httpRequest(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    ctx,
    {
      method: "POST",
      timeoutMs: TELEGRAM_TIMEOUT_MS,
      label: "Telegram sendMessage",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  );

  const rawBody = await response.text();
  let payload: TelegramApiResponse | null = null;
  try {
    payload = JSON.parse(rawBody) as TelegramApiResponse;
  } catch {
    payload = null;
  }

  return { httpOk: response.ok, status: response.status, payload };
}

function telegramError(call: TelegramCall): Error {
  const description =
    call.payload?.description?.trim() || `HTTP ${call.status} without a description`;
  return new Error(`Telegram sendMessage failed: ${truncate(description, 300)}`);
}

/**
 * Send one HTML message to the configured channel. A single short 429 retry is
 * attempted (Telegram occasionally asks for a 1-3 second pause).
 */
export async function sendTelegramMessage(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHANNEL_ID">,
  text: string,
  ctx: RequestContext,
): Promise<{ messageId?: number }> {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const channelId = env.TELEGRAM_CHANNEL_ID?.trim();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  if (!channelId) {
    throw new Error("TELEGRAM_CHANNEL_ID is not configured");
  }

  const first = await callTelegram(botToken, channelId, text, ctx);

  if (first.httpOk && first.payload?.ok === true) {
    return { messageId: first.payload.result?.message_id };
  }

  if (first.status === 429) {
    const retryAfter = first.payload?.parameters?.retry_after;
    if (
      typeof retryAfter === "number" &&
      retryAfter > 0 &&
      retryAfter <= 3 &&
      ctx.budget.remaining > 0
    ) {
      await sleep(retryAfter * 1_000);
      const second = await callTelegram(botToken, channelId, text, ctx);
      if (second.httpOk && second.payload?.ok === true) {
        return { messageId: second.payload.result?.message_id };
      }
      throw telegramError(second);
    }
  }

  throw telegramError(first);
}
