import { describe, expect, it } from "vitest";
import {
  normalizeHashtags,
  normalizeSummary,
  summarizeStory,
} from "../src/gemini";
import { loadConfig } from "../src/pipeline";
import {
  decodeEntities,
  extractArticleText,
  htmlToText,
  isScrapableUrl,
} from "../src/scraper";
import { buildTelegramMessage } from "../src/telegram";
import type { Env } from "../src/types";
import {
  createRequestContext,
  escapeAttr,
  escapeHtml,
  httpRequest,
  intFromEnv,
  truncate,
} from "../src/utils";

describe("htmlToText", () => {
  it("strips scripts, navigation, footers and tags", () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <nav>menu here</nav>
          <article>
            <h1>Hello &amp; welcome</h1>
            <p>First <strong>paragraph</strong>.</p>
            <ul><li>One</li><li>Two</li></ul>
            <script>alert("xss")</script>
          </article>
          <footer>footer text</footer>
        </body>
      </html>`;

    const text = htmlToText(html);

    expect(text).toContain("Hello & welcome");
    expect(text).toContain("First paragraph.");
    expect(text).toContain("• One");
    expect(text).toContain("• Two");
    expect(text).not.toContain("menu here");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("footer text");
    expect(text).not.toContain("<");
  });

  it("normalizes whitespace and preserves Persian ZWNJ entities", () => {
    const text = htmlToText("<p>سلام&zwnj;ها   دنیا</p>");
    expect(text).toBe("سلام\u200cها دنیا");
  });

  it("handles truncated and adversarial markup without quadratic scans", () => {
    const inputs = [
      "<a ".repeat(80_000),
      "<div".repeat(80_000),
      "<!--".repeat(80_000),
      `${"<span ".repeat(50_000)}>`,
    ];

    for (const html of inputs) {
      expect(html.length).toBeGreaterThan(200_000);
      expect(() => htmlToText(html)).not.toThrow();
      expect(extractArticleText(html)).toBeNull();
    }
  }, 3_000);
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities in one pass", () => {
    expect(decodeEntities("&lt;tag&gt; &amp; &#39; &#x1F600;")).toBe(
      "<tag> & ' 😀",
    );
  });

  it("does not double-decode escaped entities", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("&not-a-real-entity;")).toBe("&not-a-real-entity;");
  });
});

describe("isScrapableUrl", () => {
  it("accepts normal article URLs", () => {
    expect(isScrapableUrl("https://example.com/a-post")).toBe(true);
    expect(isScrapableUrl("http://example.com/post?utm=1")).toBe(true);
  });

  it("rejects binary resources and non-http URLs", () => {
    expect(isScrapableUrl("https://example.com/paper.pdf")).toBe(false);
    expect(isScrapableUrl("https://example.com/paper.PDF?dl=1")).toBe(false);
    expect(isScrapableUrl("https://example.com/image.png")).toBe(false);
    expect(isScrapableUrl("ftp://example.com/post")).toBe(false);
    expect(isScrapableUrl("mailto:test@example.com")).toBe(false);
    expect(isScrapableUrl(undefined)).toBe(false);
  });

  it("rejects localhost, private IPs and internal hostnames", () => {
    expect(isScrapableUrl("http://localhost:8080/admin")).toBe(false);
    expect(isScrapableUrl("http://127.0.0.1/")).toBe(false);
    expect(isScrapableUrl("http://10.0.0.5/post")).toBe(false);
    expect(isScrapableUrl("http://172.20.1.1/post")).toBe(false);
    expect(isScrapableUrl("http://192.168.1.1/post")).toBe(false);
    expect(isScrapableUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isScrapableUrl("http://[::1]/post")).toBe(false);
    expect(isScrapableUrl("http://[fd00::1]/post")).toBe(false);
    expect(isScrapableUrl("https://metadata.google.internal/computeMetadata")).toBe(false);
    expect(isScrapableUrl("https://printer.local/status")).toBe(false);
    expect(isScrapableUrl("https://8.8.8.8/post")).toBe(true);
  });
});

describe("httpRequest", () => {
  function inputUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  it("charges every redirect hop and follows relative locations", async () => {
    const ctx = createRequestContext(3);
    const seen: string[] = [];

    ctx.fetchImpl = async (input) => {
      const url = inputUrl(input);
      seen.push(url);
      if (url === "https://example.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const response = await httpRequest("https://example.com/start", ctx, {
      label: "test",
      validateRedirect: isScrapableUrl,
    });

    expect(await response.text()).toBe("ok");
    expect(seen).toEqual([
      "https://example.com/start",
      "https://example.com/next",
    ]);
    expect(ctx.budget.usage).toEqual({ used: 2, max: 3 });
  });

  it("rejects a redirect to a private address", async () => {
    const ctx = createRequestContext(5);

    ctx.fetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });

    await expect(
      httpRequest("https://example.com/start", ctx, {
        label: "test",
        validateRedirect: isScrapableUrl,
      }),
    ).rejects.toThrow(/Blocked redirect/);
    expect(ctx.budget.usage.used).toBe(1);
  });

  it("stops after the configured redirect limit", async () => {
    const ctx = createRequestContext(10);

    ctx.fetchImpl = async (input) =>
      new Response(null, {
        status: 307,
        headers: { location: `${inputUrl(input)}/again` },
      });

    await expect(
      httpRequest("https://example.com/start", ctx, {
        label: "test",
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/Too many redirects/);
    expect(ctx.budget.usage.used).toBe(3);
  });
});

describe("extractArticleText", () => {
  it("prefers the article element and returns enough readable text", () => {
    const paragraph = "A detailed sentence about software engineering. ".repeat(8);
    const html = `<nav>skip me</nav><article><h1>Title</h1><p>${paragraph}</p></article><footer>skip me too</footer>`;
    const text = extractArticleText(html);

    expect(text).not.toBeNull();
    expect(text).toContain("A detailed sentence");
    expect(text).not.toContain("skip me");
  });

  it("returns null for pages with too little text", () => {
    expect(extractArticleText("<p>Too short.</p>")).toBeNull();
  });
});

describe("normalizeHashtags", () => {
  it("sanitizes, de-duplicates and caps hashtags", () => {
    const tags = normalizeHashtags([
      "#AI",
      "#برنامه نویسی",
      "#C++",
      "#ai",
      "Node.js",
      "#a-b",
      `#${"x".repeat(50)}`,
    ]);

    expect(tags).toEqual([
      "#AI",
      "#برنامه_نویسی",
      "#CPlusPlus",
      "#Node_js",
      "#a_b",
    ]);
  });

  it("drops values that become empty", () => {
    expect(normalizeHashtags(["#", "!!!", 42])).toEqual([]);
  });
});

describe("normalizeSummary", () => {
  it("cleans markdown, validates fields and pads missing hashtags", () => {
    const summary = normalizeSummary(
      {
        title_fa: "«یک عنوان»",
        summary_fa: "**مهم**:\n- یک\n* دو",
        hashtags: ["#AI"],
      },
      "Fallback title",
    );

    expect(summary.title_fa).toBe("یک عنوان");
    expect(summary.summary_fa).toBe("مهم:\n• یک\n• دو");
    expect(summary.hashtags[0]).toBe("#AI");
    expect(summary.hashtags.length).toBeGreaterThanOrEqual(3);
    expect(summary.hashtags.length).toBeLessThanOrEqual(5);
  });

  it("keeps legitimate trailing quotes in a title", () => {
    const summary = normalizeSummary(
      {
        title_fa: 'Rust <3 & "WASM"',
        summary_fa: "خلاصه",
        hashtags: ["#Rust"],
      },
      "fallback",
    );

    expect(summary.title_fa).toBe('Rust <3 & "WASM"');
  });

  it("throws when the summary is empty", () => {
    expect(() => normalizeSummary({ summary_fa: "  " }, "fallback")).toThrow(
      /empty summary/,
    );
  });
});

describe("buildTelegramMessage", () => {
  const summary = {
    title_fa: 'Rust <3 & "WebAssembly"',
    summary_fa: "خلاصه‌ی تست.",
    hashtags: ["#Rust", "#WASM", "#برنامه_نویسی"],
  };

  it("escapes dynamic text and builds both links", () => {
    const message = buildTelegramMessage(
      { id: 123, url: "https://example.com/a?b=1&c=2" },
      summary,
    );

    expect(message).toContain('<b>Rust &lt;3 &amp; "WebAssembly"</b>');
    expect(message).toContain(
      'href="https://example.com/a?b=1&amp;c=2"',
    );
    expect(message).toContain("https://news.ycombinator.com/item?id=123");
    expect(message).toContain("منبع اصلی");
    expect(message).toContain("#Rust #WASM #برنامه_نویسی");
    expect(message).toContain('href="https://t.me/AutoHackerNewsFarsi"');
    expect(message).toContain("@AutoHackerNewsFarsi");
  });

  it("uses a custom channel handle and drops an invalid one", () => {
    const custom = buildTelegramMessage({ id: 1 }, summary, "@MyHNChannel");
    expect(custom).toContain('href="https://t.me/MyHNChannel"');
    expect(custom).toContain("@MyHNChannel");

    const invalid = buildTelegramMessage({ id: 1 }, summary, "not a handle");
    expect(invalid).not.toContain("📣");
  });

  it("omits the source link for text-only HN posts", () => {
    const message = buildTelegramMessage({ id: 456 }, summary);

    expect(message).not.toContain("منبع اصلی");
    expect(message).toContain("https://news.ycombinator.com/item?id=456");
  });

  it("omits a source link that is not a valid http(s) URL", () => {
    const message = buildTelegramMessage(
      { id: 789, url: "javascript:alert(1)" },
      summary,
    );

    expect(message).not.toContain("منبع اصلی");
    expect(message).not.toContain("javascript:");
    expect(message).toContain("https://news.ycombinator.com/item?id=789");
  });
});

describe("summarizeStory", () => {
  const config = {
    model: "gemini-3.5-flash-lite",
    minScore: 100,
    maxPostsPerRun: 2,
    maxStoriesToScan: 30,
    maxComments: 5,
    thinkingBudget: 0,
  };

  const summaryPayload = {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            {
              text: JSON.stringify({
                title_fa: "عنوان تست",
                summary_fa: "خلاصهٔ تست",
                hashtags: ["#AI", "#Test", "#Gemini"],
              }),
            },
          ],
        },
      },
    ],
  };

  it("retries a transient Gemini 503 once", async () => {
    const ctx = createRequestContext(5);
    let calls = 0;

    ctx.fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "high demand" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(summaryPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const summary = await summarizeStory(
      { id: 1, type: "story", title: "Test", score: 100, time: 1 },
      "Article content",
      "article",
      config,
      "test-key",
      ctx,
    );

    expect(summary.title_fa).toBe("عنوان تست");
    expect(calls).toBe(2);
    expect(ctx.budget.usage.used).toBe(2);
  }, 5_000);

  it("does not retry a non-retryable Gemini error", async () => {
    const ctx = createRequestContext(5);
    let calls = 0;

    ctx.fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      summarizeStory(
        { id: 1, type: "story", title: "Test", score: 100, time: 1 },
        "Article content",
        "article",
        config,
        "bad-key",
        ctx,
      ),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});

describe("configuration", () => {
  it("uses safe defaults when vars are missing", () => {
    expect(loadConfig({} as Env)).toEqual({
      model: "gemini-3.5-flash-lite",
      minScore: 100,
      maxPostsPerRun: 2,
      maxStoriesToScan: 30,
      maxComments: 5,
      thinkingBudget: 0,
    });
  });

  it("clamps numeric environment variables", () => {
    expect(intFromEnv(undefined, 2, 1, 10)).toBe(2);
    expect(intFromEnv("abc", 2, 1, 10)).toBe(2);
    expect(intFromEnv("0", 2, 1, 10)).toBe(1);
    expect(intFromEnv("99", 2, 1, 10)).toBe(10);
  });
});

describe("small helpers", () => {
  it("escapes Telegram HTML", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeAttr('a"b')).toBe("a&quot;b");
  });

  it("truncates on a word boundary", () => {
    expect(truncate("hello beautiful world", 12)).toBe("hello…");
  });
});
