Build a complete, production-ready Cloudflare Worker project (TypeScript + Wrangler CLI) that monitors Hacker News, summarizes high-value stories into natural, developer-friendly Persian using the Google Gemini API (free tier), and posts them to a Telegram channel.

### 1. Tech Stack & Constraints
- **Runtime:** Cloudflare Workers (Free Tier) — use TypeScript and standard Web APIs (`fetch`) only. Do NOT use Node.js-only libraries or heavy SDKs that bloat the bundle or exceed the free-tier CPU limit (10ms CPU time) and subrequest limit (50 subrequests per invocation).
- **Storage:** Cloudflare KV for state management and deduplication.
- **Scheduling:** Cloudflare Cron Triggers (`*/15 * * * *` — every 15 minutes).
- **AI Model:** Google Gemini REST API (Free Tier), with the model name configurable via `wrangler.toml` env var (e.g., `GEMINI_MODEL = "gemini-2.5-flash"`).
- **Messaging:** Telegram Bot API (`sendMessage`) via direct `fetch`.

### 2. Core Functional Requirements

#### A. Hacker News Ingestion & Filtering
- Fetch the top story IDs from the official HN API (`https://hacker-news.firebaseio.com/v0/topstories.json`).
- Inspect only the top 25–30 stories per run to stay safely under Cloudflare's 50-subrequest limit.
- Filter criteria:
  - `type === "story"` (ignore deleted/dead items).
  - Minimum score threshold configurable via env var `MIN_SCORE` (default: `100`).
- **Start-from-now behavior (No old-news spam):**
  - On the very first execution, store a `bot_init_timestamp` (current Unix epoch in seconds) in KV.
  - Ignore any story whose HN `time` is older than `bot_init_timestamp` so only stories published *after* the bot is deployed get posted.
- **Deduplication:**
  - Store each posted story ID in KV under key `seen:<id>` with a 30-day TTL (`expirationTtl: 2592000`).
- **Rate Limiting:**
  - Post a maximum of `MAX_POSTS_PER_RUN` (default: `2`) stories per cron run to avoid flooding the channel and to stay well within Gemini's free-tier limits.

#### B. Article Content Extraction & Fallback
- If the story has an external `url` (and it's not a PDF/image/binary file), fetch the page with a short timeout (e.g., 5 seconds) and a clean User-Agent.
- Lightweightly strip `<script>`, `<style>`, `<noscript>`, `<nav>`, `<footer>`, and HTML tags to extract readable text, then truncate to ~6,000 characters.
- **Fallback:** If the story has no external `url` (e.g., Ask HN / Show HN), or if fetching/extracting fails (paywall, 403, timeout, too little text), fetch the top 5–6 top-level comments from the HN item's `kids` array and combine them with the story title and `item.text` as context for summarization.

#### C. Gemini Summarization (Natural Persian)
- Call the Gemini `generateContent` REST endpoint requesting structured JSON output (`responseMimeType: "application/json"`) with this schema:
  - `title_fa`: Catchy, accurate Persian headline.
  - `summary_fa`: Concise summary (3–5 sentences or short bullet points) explaining *what* this is and *why* it matters to developers/tech enthusiasts.
  - `hashtags`: Array of 3–5 relevant Persian or English hashtags (without spaces, e.g., `#AI`, `#Rust`, `#برنامه_نویسی`).
- **Tone & Writing Style (Critical):**
  - Write in fluent, natural, technical-yet-casual Persian (لحن فنی و خودمونی — like a knowledgeable Iranian software engineer sharing an interesting link with peers).
  - Strictly avoid robotic, literal word-for-word translation.
  - Keep standard technical terms (e.g., API, Kernel, Docker, Open Source, LLM) in English or natural Persian tech phrasing.

#### D. Telegram Posting Format
- Use `parse_mode: "HTML"` and properly escape all dynamic text (`&`, `<`, `>`) to prevent Telegram API formatting errors.
- Set `disable_web_page_preview: true` for a clean, compact channel layout.
- Message template:
  - Bold Persian title
  - Blank line + Persian summary
  - Blank line + Original article link (`🔗 منبع اصلی`) — omit if it's a text-only HN post
  - Hacker News discussion link (`💬 بحث و کامنت‌ها در Hacker News` linking to `https://news.ycombinator.com/item?id=<id>`)
  - Blank line + Hashtags

#### E. Manual Testing & Error Handling
- Expose an HTTP `fetch` handler with a `GET /trigger` endpoint protected by a `TRIGGER_SECRET` secret (via `Authorization: Bearer <secret>` or `?secret=<secret>`) so I can manually run and debug the pipeline anytime.
- Wrap per-story processing in `try/catch` so a failure on one story logs the error cleanly and continues to the next candidate instead of crashing the whole run.

### 3. Expected Deliverables
1. Clean, modular project structure (`src/index.ts`, `src/hn.ts`, `src/scraper.ts`, `src/gemini.ts`, `src/telegram.ts`, `src/types.ts`).
2. Complete `package.json`, `tsconfig.json`, `wrangler.toml` (with KV binding, Cron trigger, and non-secret env vars), and `.dev.vars.example`.
3. A clear, step-by-step `README.md` covering:
   - Installing dependencies & authenticating Wrangler (`npx wrangler login`).
   - Creating the Cloudflare KV namespace and updating its ID in `wrangler.toml`.
   - Setting secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `GEMINI_API_KEY`, `TRIGGER_SECRET`) via `wrangler secret put`.
   - Local testing (`wrangler dev`) and production deployment (`wrangler deploy`).
