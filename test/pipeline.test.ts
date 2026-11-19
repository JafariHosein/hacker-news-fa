import { afterEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../src/pipeline";
import type { Env, HNItem, StorySummary } from "../src/types";

const ARTICLE_HTML = `<html><body><nav>menu</nav><article><h1>Title</h1><p>${"Useful article text about software. ".repeat(20)}</p></article></body></html>`;

const SUMMARY: StorySummary = {
  title_fa: "عنوان فارسی تست",
  summary_fa: "این یک خلاصه‌ی تست برای بررسی پایپ‌لاین است.",
  hashtags: ["#AI", "#Test", "#Cloudflare"],
};

interface FakeKv {
  store: Map<string, string>;
  putOptions: Map<string, unknown>;
  kv: KVNamespace;
}

function createFakeKv(): FakeKv {
  const store = new Map<string, string>();
  const putOptions = new Map<string, unknown>();

  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, options?: unknown) => {
      store.set(key, value);
      if (options) putOptions.set(key, options);
    },
  } as unknown as KVNamespace;

  return { store, putOptions, kv };
}

function createEnv(kv: KVNamespace): Env {
  return {
    HN_KV: kv,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHANNEL_ID: "@test-channel",
    GEMINI_API_KEY: "test-gemini-key",
    TRIGGER_SECRET: "test-trigger-secret",
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}

function geminiResponse(summary: StorySummary = SUMMARY): Response {
  return jsonResponse({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(summary) }] },
      },
    ],
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runPipeline", () => {
  it("posts an eligible story, escapes the message and stores dedup state", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const story: HNItem = {
      id: 1001,
      type: "story",
      title: 'Test <Title> & "quotes"',
      score: 500,
      time: now + 60,
      url: "https://example.com/post?a=1&b=2",
      descendants: 42,
    };
    const { store, putOptions, kv } = createFakeKv();
    const env = createEnv(kv);
    let telegramBody = "";
    let geminiUrl = "";
    let geminiBody = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) return jsonResponse([story.id]);
        if (url.endsWith(`/item/${story.id}.json`)) return jsonResponse(story);
        if (url === story.url) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiUrl = url;
          geminiBody = String(init?.body ?? "");
          return geminiResponse({ ...SUMMARY, title_fa: 'Rust <3 & "WASM"' });
        }
        if (url.includes("api.telegram.org")) {
          telegramBody = String(init?.body ?? "");
          return jsonResponse({ ok: true, result: { message_id: 77 } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http" });

    expect(result.ok).toBe(true);
    expect(result.posted).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.results[0]).toMatchObject({
      id: story.id,
      status: "posted",
      source: "article",
      messageId: 77,
    });

    expect(store.get(`seen:${story.id}`)).toBe("1");
    expect(store.get("bot_init_timestamp")).toBeTruthy();
    expect(putOptions.get(`seen:${story.id}`)).toMatchObject({
      expirationTtl: 2_592_000,
    });

    const sent = JSON.parse(telegramBody) as {
      text: string;
      parse_mode: string;
      disable_web_page_preview: boolean;
    };
    expect(sent.parse_mode).toBe("HTML");
    expect(sent.disable_web_page_preview).toBe(true);
    expect(sent.text).toContain('Rust &lt;3 &amp; "WASM"');
    expect(sent.text).toContain("https://example.com/post?a=1&amp;b=2");
    expect(sent.text).toContain("https://news.ycombinator.com/item?id=1001");
    expect(sent.text).toContain('href="https://t.me/AutoHackerNewsFarsi"');
    expect(sent.text).toContain("@AutoHackerNewsFarsi");

    expect(geminiUrl).toContain("gemini-3.5-flash-lite");
    const geminiRequest = JSON.parse(geminiBody) as {
      systemInstruction: { parts: Array<{ text: string }> };
      generationConfig: {
        responseMimeType: string;
        responseSchema: { required: string[] };
      };
    };
    expect(geminiRequest.generationConfig.responseMimeType).toBe("application/json");
    expect(geminiRequest.generationConfig.responseSchema.required).toEqual([
      "title_fa",
      "summary_fa",
      "hashtags",
    ]);
    expect(geminiRequest.systemInstruction.parts[0]?.text).toContain("فارسی");
  });

  it("skips stories already marked as seen", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const story: HNItem = {
      id: 1002,
      type: "story",
      title: "Already posted",
      score: 300,
      time: now + 60,
      url: "https://example.com/already",
    };
    const { kv } = createFakeKv();
    const env = createEnv(kv);
    let itemFetches = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) return jsonResponse([story.id]);
        if (url.endsWith(`/item/${story.id}.json`)) {
          itemFetches += 1;
          return jsonResponse(story);
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return geminiResponse();
        }
        if (url.includes("api.telegram.org")) {
          return jsonResponse({ ok: true, result: { message_id: 1 } });
        }
        if (url === story.url) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await runPipeline(env, { trigger: "http" });
    const second = await runPipeline(env, { trigger: "http" });

    expect(second.posted).toBe(0);
    expect(second.eligible).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(second.results).toEqual([]);
    expect(itemFetches).toBe(1);
  });

  it("finds a fresh story below a long prefix of seen stories", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const seenStories: HNItem[] = Array.from({ length: 25 }, (_, index) => ({
      id: 5_000 + index,
      type: "story",
      title: `Old story ${index}`,
      score: 500,
      time: now + 60,
      url: `https://example.com/old-${index}`,
    }));
    const freshStory: HNItem = {
      id: 9_001,
      type: "story",
      title: "Fresh story at rank 26",
      score: 337,
      time: now + 60,
      url: "https://example.com/fresh",
    };
    const { store, kv } = createFakeKv();
    for (const story of seenStories) {
      store.set(`seen:${story.id}`, "1");
    }
    const env = createEnv(kv);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) {
          return jsonResponse([...seenStories, freshStory].map((story) => story.id));
        }
        if (url.endsWith(`/item/${freshStory.id}.json`)) {
          return jsonResponse(freshStory);
        }
        if (url === freshStory.url) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return geminiResponse();
        }
        if (url.includes("api.telegram.org")) {
          return jsonResponse({ ok: true, result: { message_id: 123 } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http" });

    expect(result.scanned).toBe(26);
    expect(result.eligible).toBe(1);
    expect(result.duplicatesSkipped).toBe(25);
    expect(result.posted).toBe(1);
    expect(result.results[0]).toMatchObject({
      id: freshStory.id,
      status: "posted",
      messageId: 123,
    });
  });

  it("falls back to comments when the article returns 403", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const story: HNItem = {
      id: 1003,
      type: "story",
      title: "Paywalled article",
      score: 250,
      time: now + 60,
      url: "https://blocked.example/post",
      kids: [2001],
      descendants: 4,
    };
    const comment: HNItem = {
      id: 2001,
      type: "comment",
      by: "alice",
      text: `<p>${"comment insight about the cache design. ".repeat(10)}</p>`,
    };
    const { kv } = createFakeKv();
    const env = createEnv(kv);
    let geminiRequestBody = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) return jsonResponse([story.id]);
        if (url.endsWith(`/item/${story.id}.json`)) return jsonResponse(story);
        if (url.endsWith(`/item/${comment.id}.json`)) return jsonResponse(comment);
        if (url === story.url) {
          return new Response("Forbidden", { status: 403 });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiRequestBody = String(init?.body ?? "");
          return geminiResponse();
        }
        if (url.includes("api.telegram.org")) {
          return jsonResponse({ ok: true, result: { message_id: 88 } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http" });

    expect(result.posted).toBe(1);
    expect(result.results[0]).toMatchObject({
      status: "posted",
      source: "comments",
      messageId: 88,
    });
    expect(geminiRequestBody).toContain("comment insight about the cache design");
    expect(geminiRequestBody).toContain("alice");
  });

  it("stops after three consecutive failures instead of draining the budget", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const stories: HNItem[] = [3001, 3002, 3003, 3004].map((id) => ({
      id,
      type: "story",
      title: `Failing story ${id}`,
      score: 400,
      time: now + 60,
      url: `https://example.com/fail-${id}`,
    }));
    const { kv } = createFakeKv();
    const env = createEnv(kv);
    let geminiCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) {
          return jsonResponse(stories.map((story) => story.id));
        }
        const item = stories.find((story) => url.endsWith(`/item/${story.id}.json`));
        if (item) return jsonResponse(item);
        if (url.startsWith("https://example.com/")) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          geminiCalls += 1;
          return jsonResponse({ error: { message: "API key not valid" } });
        }
        if (url.includes("api.telegram.org")) {
          throw new Error("Telegram must not be called for failed stories");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http" });

    expect(result.posted).toBe(0);
    expect(result.stoppedReason).toBe("too_many_errors");
    expect(result.results).toHaveLength(3);
    expect(result.errors).toHaveLength(3);
    expect(geminiCalls).toBe(3);
    expect(result.budget.used).toBeLessThan(45);
  });

  it("does not treat empty stories as a systemic failure", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const emptyStories: HNItem[] = [4001, 4002, 4003, 4004].map((id) => ({
      id,
      type: "story",
      title: `Empty story ${id}`,
      score: 400,
      time: now + 60,
    }));
    const validStory: HNItem = {
      id: 4005,
      type: "story",
      title: "Valid story",
      score: 500,
      time: now + 60,
      url: "https://example.com/valid",
    };
    const stories = [...emptyStories, validStory];
    const { kv } = createFakeKv();
    const env = createEnv(kv);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) {
          return jsonResponse(stories.map((story) => story.id));
        }
        const item = stories.find((story) => url.endsWith(`/item/${story.id}.json`));
        if (item) return jsonResponse(item);
        if (url === validStory.url) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return geminiResponse();
        }
        if (url.includes("api.telegram.org")) {
          return jsonResponse({ ok: true, result: { message_id: 99 } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http" });

    expect(result.posted).toBe(1);
    expect(result.stoppedReason).not.toBe("too_many_errors");
    expect(result.results).toHaveLength(5);
    expect(result.results.filter((item) => item.status === "error")).toHaveLength(4);
    expect(result.results[4]).toMatchObject({ status: "posted", messageId: 99 });
  });

  it("previews without posting or writing seen keys in dry-run mode", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const story: HNItem = {
      id: 1004,
      type: "story",
      title: "Dry run story",
      score: 200,
      time: now + 60,
      url: "https://example.com/dry",
    };
    const { store, kv } = createFakeKv();
    const env = createEnv(kv);
    let telegramCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/topstories.json")) return jsonResponse([story.id]);
        if (url.endsWith(`/item/${story.id}.json`)) return jsonResponse(story);
        if (url === story.url) {
          return new Response(ARTICLE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.includes("generativelanguage.googleapis.com")) {
          return geminiResponse();
        }
        if (url.includes("api.telegram.org")) {
          telegramCalls += 1;
          return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await runPipeline(env, { trigger: "http", dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.posted).toBe(0);
    expect(result.results[0]).toMatchObject({
      status: "preview",
      source: "article",
    });
    expect(result.results[0]?.preview).toContain("عنوان فارسی تست");
    expect(telegramCalls).toBe(0);
    expect(store.has(`seen:${story.id}`)).toBe(false);
  });
});
