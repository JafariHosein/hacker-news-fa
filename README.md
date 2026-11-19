<p align="center">
  <img src="assets/logo-b.png" alt="Hacker News فارسی" width="160" height="160" />
</p>

<h1 align="center">Hacker News فارسی</h1>

<p align="center">
  خلاصهٔ فارسیِ مهم‌ترین خبرهای Hacker News، خودکار در تلگرام.
</p>

<p align="center">
  <a href="https://t.me/AutoHackerNewsFarsi"><b>کانال تلگرام</b></a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#configuration">Configuration</a>
  ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

A production-ready Cloudflare Worker that watches Hacker News, picks stories
above a score threshold, summarizes them in fluent, developer-friendly Persian
with Google Gemini, and posts each one to a Telegram channel.

It runs on the Cloudflare Workers free tier with **zero runtime dependencies**
(no SDKs, no Node.js-only libraries), stores all state in Workers KV, and is
scheduled with a Cron Trigger every 15 minutes.

## این پروژه چیست؟

این پروژه یک Worker روی Cloudflare است که هر ۱۵ دقیقه اخبار Hacker News را
می‌خواند، خبرهای تازه و مهم را انتخاب می‌کند، با Gemini به فارسی خلاصه می‌کند و
خودکار در کانال تلگرام منتشر می‌کند. همه‌چیز روی Free Tier کلودفلر اجرا می‌شود و
به سرور یا کامپیوتر شخصی نیاز ندارد.

- فقط خبرهای تازه و بالای امتیاز مشخص
- خلاصهٔ فارسی + لینک خبر اصلی و بحث Hacker News
- جلوگیری از ارسال تکراری با KV
- اجرای خودکار هر ۱۵ دقیقه، بدون دخالت دستی

## Live deployment

- **Telegram channel:** [@AutoHackerNewsFarsi](https://t.me/AutoHackerNewsFarsi)
- **Worker health check:** [hacker-news-fa.hosseindev1552.workers.dev/health](https://hacker-news-fa.hosseindev1552.workers.dev/health)

## Features

- **Hacker News ingestion** from the official Firebase API.
- **Score + recency filtering** with `MIN_SCORE` and a deployment timestamp, so
  the channel never gets a flood of old news.
- **Deduplication** with 30-day TTL keys in KV; seen IDs are filtered before
  item fetches so quiet periods do not waste the subrequest budget.
- **Article extraction** with a small, dependency-free HTML-to-text pipeline.
- **Smart fallback** to the post text and the top comments when the article is
  paywalled, blocked, binary, or too short.
- **Gemini structured output** (`responseMimeType: "application/json"`) for a
  Persian headline, summary, and hashtags.
- **Telegram HTML** with proper escaping, no link previews, a discussion link
  for every story, and a clickable channel handle footer.
- **Protected manual trigger** (`GET /trigger`) for debugging, plus a dry-run
  mode that renders the message without posting.
- **Subrequest guard** that keeps each invocation safely below the free-tier
  limit of 50 subrequests, including redirect hops.
- **Redirect safety**: article redirects are followed manually, re-validated at
  every hop, and cannot reach localhost or private addresses.
- **Per-story error isolation**: one broken article or API call cannot abort the
  entire run.

## How it works

```text
Cloudflare Cron (*/15 * * * *)
              │
GET /trigger ─┴──> runPipeline()
                       │
                       ├─ 1. GET /v0/topstories.json
                       ├─ 2. Skip IDs already marked seen (KV reads, no
                       │        subrequest cost), then GET /v0/item/<id>.json
                       │        for the first 30 stories
                       ├─ 3. Filter: type=story, score >= MIN_SCORE,
                       │        submitted after init timestamp
                       ├─ 4. Build context: article text
                       │        └─ fallback → HN self text + top 5 comments
                       ├─ 5. Gemini generateContent → JSON
                       │        { title_fa, summary_fa, hashtags }
                       ├─ 6. Telegram sendMessage (HTML)
                       └─ 7. KV seen:<id> = 1 (TTL 30 days)
```

The first time the Worker runs, it stores `bot_init_timestamp` in KV. Any story
submitted before that moment is ignored. This is intentional: deploying the bot
will not dump a week of old links into your channel. Only stories published
after deployment are eligible.

## Project layout

```text
.
├── src/
│   ├── index.ts        # Worker entry point: /, /trigger, scheduled()
│   ├── pipeline.ts     # Orchestration, filtering, dedup, subrequest budget
│   ├── hn.ts           # Hacker News Firebase API client
│   ├── scraper.ts      # Article fetch + lightweight HTML-to-text
│   ├── gemini.ts       # Gemini REST call, schema, validation/normalization
│   ├── telegram.ts     # HTML message formatting + Bot API client
│   ├── types.ts        # Shared types
│   └── utils.ts        # fetch timeout, budget, escaping, helpers
├── test/
│   ├── helpers.test.ts # Unit tests for pure helpers
│   └── pipeline.test.ts # Mocked end-to-end pipeline tests (dedup, fallback, dry run)
├── assets/             # Channel logo sources and rendered PNGs
├── PROMPT.md           # Original product requirements
├── wrangler.toml       # KV binding, cron trigger, non-secret vars
├── .dev.vars.example   # Template for local secrets
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Branding

The channel avatar is [`assets/logo-b.png`](assets/logo-b.png); the editable
vector source is [`assets/logo-b.svg`](assets/logo-b.svg). Two alternative
concepts are kept in `assets/logo-a.*` and `assets/logo-c.*`.

The Worker appends the public channel handle from `TELEGRAM_CHANNEL_HANDLE` to
every post, so readers can find and share the channel.

## Prerequisites

- Node.js 22.12 or newer, plus npm. (Wrangler 4.165 requires this.)
- A Cloudflare account (the free plan is enough).
- A Telegram bot and an admin role for it in the target channel.
- A Google AI Studio API key for Gemini.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Telegram bot and channel

1. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, and save the
   token (looks like `123456789:AAH...`).
2. Create a channel (or use an existing one).
3. Add the bot to the channel as an **administrator** with the
   **Post messages** permission. Without this the Bot API returns
   `403 Forbidden: bot is not a member of the channel chat`.
4. Decide which `chat_id` to use:
   - Public channel: `@your_channel_username` (recommended, easy to verify).
   - Private or numeric id: `-100...`. You can find it with
     `https://api.telegram.org/bot<TOKEN>/getUpdates` after posting in the
     channel, or with a helper bot such as `@userinfobot`.

### 3. Create a Gemini API key

Go to <https://aistudio.google.com/app/apikey>, create a key, and copy it.
The default model is `gemini-3.5-flash-lite`, a current, stable model that is
free of charge on the Gemini API free tier. You can change it later with the
`GEMINI_MODEL` variable in `wrangler.toml`. Note that the old
`gemini-2.5-flash` used in many examples is deprecated and stops accepting new
API traffic on December 1, 2026, so do not use it for a fresh deployment.

### 4. Create the KV namespace

```bash
npx wrangler login
npx wrangler kv namespace create HN_KV
```

The command prints a namespace id. Put it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "HN_KV"
id = "abc123..."
```

Local development uses a simulated KV namespace and does not need a real id,
but production deployment does.

### 5. Upload secrets

Secrets are encrypted and are never stored in the repository:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHANNEL_ID
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TRIGGER_SECRET
```

Generate a strong trigger secret with:

```bash
openssl rand -hex 32
```

For non-interactive CI deployments you can also pipe a value:

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### 6. Deploy

```bash
npm run check   # type-check + bundle smoke test
npm run deploy
```

Wrangler prints the Worker URL and registers the cron trigger automatically.
The default schedule is `*/15 * * * *` (every 15 minutes, UTC).

### 7. Trigger it manually

```bash
curl -sS \
  -H "Authorization: Bearer <TRIGGER_SECRET>" \
  "https://hacker-news-fa.<your-subdomain>.workers.dev/trigger?dry=1&limit=1"
```

`dry=1` runs the whole pipeline and returns the rendered Telegram HTML, but
does **not** send a message and does not write dedup keys. This is the safest
way to verify Gemini and article extraction.

When you are ready for a real post, omit `dry=1`.

> The first live run only records the init timestamp. It will not post old
> stories. New stories become eligible as they are submitted and cross
> `MIN_SCORE`.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with your real local values
npm run dev
```

Then call the local endpoint:

```bash
curl -sS \
  -H "Authorization: Bearer <your-local-TRIGGER_SECRET>" \
  "http://localhost:8787/trigger?dry=1&limit=1"
```

Notes:

- `wrangler dev` uses a local KV simulation stored under `.wrangler/state`.
  Local data is separate from production KV.
- Cron Triggers do not fire in plain `wrangler dev`; use `/trigger`.
- To test the full Telegram path locally, remove `dry=1`. Messages will go to
  the real channel configured in `.dev.vars`.
- To let the local bot consider existing stories for a one-off test, set the
  local init timestamp to a **past** Unix timestamp (it must be greater than
  zero) **and use dry-run first**:

  ```bash
  npx wrangler kv key put bot_init_timestamp 1700000000 --binding HN_KV --local
  ```

  Delete the key afterwards (`npx wrangler kv key delete bot_init_timestamp
  --binding HN_KV --local`) so the next run initializes it to "now" again. If
  the key is already `0` or invalid, the Worker replaces it with the current
  time, which is why a positive past value like `1700000000` is required.

### Useful commands

```bash
npm test             # unit tests (Vitest)
npm run typecheck    # strict TypeScript check
npm run check        # typecheck + wrangler bundle without deploying
npm run tail         # stream production logs
npx wrangler deployments list
```

## API

| Route                | Auth                              | Description                              |
| -------------------- | --------------------------------- | ---------------------------------------- |
| `GET /`              | none                              | Health check                             |
| `GET /health`        | none                              | Same as `/`                              |
| `GET /trigger`       | `Authorization: Bearer <secret>` or `?secret=<secret>` | Run the pipeline immediately |

`GET /trigger` query parameters:

| Parameter | Description |
| --------- | ----------- |
| `dry=1`   | Do not send to Telegram or write `seen:` keys; return `preview` HTML. |
| `limit=N` | Override `MAX_POSTS_PER_RUN` for this run (1-5). |

Prefer the `Authorization` header in production. Query-string secrets can end
up in access logs and browser history.

Example dry-run response (shortened):

```json
{
  "ok": true,
  "trigger": "http",
  "dryRun": true,
  "scanned": 30,
  "eligible": 6,
  "duplicatesSkipped": 0,
  "posted": 0,
  "stoppedReason": "post_limit",
  "budget": { "used": 34, "max": 45 },
  "results": [
    {
      "id": 12345678,
      "title": "Original English title",
      "score": 421,
      "status": "preview",
      "source": "article",
      "preview": "<b>عنوان فارسی</b>\n\n..."
    }
  ],
  "errors": []
}
```

## Configuration

Non-secret values live in `[vars]` in `wrangler.toml`. Secrets are uploaded with
`wrangler secret put` and are not shown in configuration files.

| Variable | Kind | Default | Description |
| -------- | ---- | ------- | ----------- |
| `GEMINI_MODEL` | var | `gemini-3.5-flash-lite` | Gemini model name. |
| `MIN_SCORE` | var | `100` | Minimum HN score a story needs. |
| `MAX_POSTS_PER_RUN` | var | `2` | Maximum posts per cron run (1-10). |
| `MAX_STORIES_TO_SCAN` | var | `30` | Top stories inspected per run (1-30). IDs already posted are skipped before item fetches. |
| `MAX_COMMENTS` | var | `5` | Top-level comments used as fallback context (0-10). |
| `TELEGRAM_CHANNEL_HANDLE` | var | `@AutoHackerNewsFarsi` | Public channel handle appended to every post. |
| `GEMINI_THINKING_BUDGET` | var | `0` | Legacy thinking-token budget for `gemini-2.5-flash*` models. `0` disables thinking there; ignored for Gemini 3+ models (3.5 Flash-Lite defaults to minimal thinking). |
| `TELEGRAM_BOT_TOKEN` | secret | — | Token from @BotFather. |
| `TELEGRAM_CHANNEL_ID` | secret | — | `@channel_name` or numeric `-100...` id. |
| `GEMINI_API_KEY` | secret | — | Google AI Studio key. |
| `TRIGGER_SECRET` | secret | — | Protects `GET /trigger`. |

### Gemini output contract

The Worker asks Gemini for JSON with:

- `title_fa`: catchy, accurate Persian headline.
- `summary_fa`: 3-5 sentences or short `•` bullets explaining what the story is
  and why developers should care.
- `hashtags`: 3-5 relevant Persian or English hashtags.

The prompt explicitly asks for a natural, technical-yet-casual Persian voice,
keeps common technical terms in English, and forbids robotic literal
translation. The response is validated and normalized in code: titles and
summaries are trimmed, markdown bullets are converted to `•`, hashtags are
sanitized, de-duplicated, and capped.

### Subrequest budget

The free Workers plan allows 50 subrequests per invocation. This project uses a
soft cap of **45** and counts every outbound `fetch` (HN API, article, Gemini,
Telegram), including each redirect hop. Seen IDs are checked in KV before item
fetches, so a quiet top list does not consume the whole budget:

```text
1 (topstories) + up to 30 (items not already seen)
  + up to 2 × (1 article + 5 comments + 1 Gemini + 1 Telegram)
```

Comment slots shrink automatically as the budget gets tight, so a full first
run still stays at or below 45. Article redirects are followed manually (up to
3 hops) and every hop is charged to the same budget, so a redirect chain cannot
silently push the invocation past Cloudflare's hard limit. The remaining slots
cover the optional Telegram 429 retry. If you raise `MAX_STORIES_TO_SCAN`,
`MAX_COMMENTS`, or `MAX_POSTS_PER_RUN`, the guard stops gracefully and reports
`"stoppedReason": "subrequest_budget"` instead of failing at Cloudflare's hard
limit.

### Free-tier notes

- **CPU:** Workers free tier gives 10 ms CPU per invocation. HTML extraction is a
  single-pass linear scanner capped at 200 KB of HTML, so truncated or
  adversarial markup (thousands of unclosed tags) cannot trigger quadratic regex
  backtracking. Avoid adding heavy parsers or SDKs.
- **KV:** 100,000 reads and 1,000 writes per day. At 96 runs/day this workload
  stays far below the write limit.
- **Gemini:** Free-tier quotas and rate limits change over time. Check your
  current limits in Google AI Studio. Transient `429`/`5xx` responses (including
  "high demand" `503`s) are retried once after 1.5 seconds; if they still fail,
  the story is logged and retried on a later run (it is not marked as seen).
- **Telegram:** Bot API limits are generous for a couple of posts per 15
  minutes; this project posts at most `MAX_POSTS_PER_RUN` (default 2) per run.

## Behavior details

- **Eligibility:** a story must be type `story`, not `deleted` or `dead`, have a
  title, `score >= MIN_SCORE`, and `time >= bot_init_timestamp`.
- **Ordering:** candidates are processed in Hacker News top-list order, which
  already accounts for recency and engagement.
- **Deduplication:** after a successful Telegram send, the Worker writes
  `seen:<id>` with a 30-day TTL. Dry runs do not write this key. If the KV write
  fails after a successful post, the post is kept and the response includes a
  warning, so you can spot the small duplicate risk.
- **Fallbacks:** if the external article cannot be fetched or has under 200
  characters of readable text, the Worker uses the HN self text and up to
  `MAX_COMMENTS` top-level comments. Deleted/dead comments are skipped.
- **HTML extraction:** a single-pass linear scanner removes comments, scripts,
  styles, navigation, footers, forms, and remaining tags; it decodes common and
  numeric HTML entities, collapses whitespace, and truncates context to 6,000
  characters.
- **Link safety:** article URLs and every redirect target are checked against
  localhost, private IP ranges, and internal suffixes. Source links in Telegram
  are only rendered for valid `http(s)` URLs.
- **Telegram formatting:** `parse_mode: "HTML"`, escaped dynamic text,
  `disable_web_page_preview: true`, Persian title in bold, source link (omitted
  for text-only posts), HN discussion link, hashtags, and a clickable channel
  handle footer (`TELEGRAM_CHANNEL_HANDLE`).
- **Errors:** each story is processed inside `try/catch`. Other stories still
  run, and the JSON response plus logs contain the failure reason. After three
  consecutive systemic failures (for example an invalid Gemini key) the run
  stops early with `"stoppedReason": "too_many_errors"` instead of spending the
  whole subrequest budget on doomed calls. Stories with no usable text do not
  count toward this breaker.

## Troubleshooting

### The trigger returns 401

The `Authorization: Bearer ...` value must exactly match `TRIGGER_SECRET`. If
you set the secret after deploying, redeploy is not required, but make sure you
are calling the right Worker URL. Check that `TRIGGER_SECRET` is not empty; the
endpoint fails closed with 503 when it is not configured.

### Telegram says "chat not found"

- Use `@channel_username` for public channels, and include the `@`.
- For numeric ids, keep the leading `-100`.
- The bot must be an administrator of the channel, not merely a member.

### Telegram says "Forbidden: bot is not a member"

Add the bot as an administrator with the "Post messages" permission, then try
again.

### No posts after deploying

This is expected on the first run: the bot only posts stories submitted **after**
`bot_init_timestamp`. Also check:

- `MIN_SCORE` may be too high for the current front page.
- The story may already be marked as seen.
- Check `npx wrangler tail` for Gemini or Telegram errors.
- Run `/trigger?dry=1&limit=1` to inspect the pipeline result.

### Gemini returns 429

You hit the free-tier quota. Wait for the quota window to reset, lower
`MAX_POSTS_PER_RUN`, or use a model with more generous limits. The story is not
marked as seen, so it is retried on a later run.

### Article extraction falls back to comments

That is normal for paywalls, bot challenges, JS-only pages, PDFs, and very short
pages. The top comments are usually enough for a useful summary.

### `wrangler deploy` complains about the KV namespace id

The checked-in `wrangler.toml` points to the production namespace. For a fresh
Cloudflare account, run `npx wrangler kv namespace create HN_KV` and replace the
`id` under `[[kv_namespaces]]` with the id returned by that command.

### Local and production data differ

`wrangler dev` uses local KV state. Production KV is only created/used after
deployment. Use `--remote` with `wrangler kv key ...` commands when inspecting
production.

## Security notes

- Never commit `.dev.vars` or any real secrets. The file is git-ignored.
- Use a long random `TRIGGER_SECRET`; prefer the `Authorization` header over
  query parameters.
- The bot only needs permission to post messages in one channel. Do not make it
  a full administrator with unrelated permissions.
- Article content is untrusted input. The summarizer is instructed to treat it
  as data, but prompt injection could still distort a summary. All model output
  is escaped before being inserted into Telegram HTML, so it cannot inject
  markup.
- Rotate the Telegram token and Gemini key immediately if either leaks.

## Acknowledgements

- [Hacker News Firebase API](https://github.com/HackerNews/API)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/), KV and Cron Triggers
- [Google Gemini API](https://ai.google.dev/)
- [Telegram Bot API](https://core.telegram.org/bots/api)

## License

No license file is included. Add one before distributing or publishing the
project.
