/**
 * Worker entry point: cron scheduling plus a protected manual trigger.
 */

import { runPipeline } from "./pipeline";
import type { Env } from "./types";
import {
  constantTimeEqual,
  getErrorMessage,
} from "./utils";

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allowed: string): Response {
  return jsonResponse(
    { ok: false, error: "Method not allowed" },
    405,
    { allow: allowed },
  );
}

/** Accept `Authorization: Bearer <secret>` or `?secret=<secret>`. */
function getProvidedSecret(request: Request, url: URL): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return url.searchParams.get("secret");
}

function parseMaxPosts(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(5, parsed);
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse({
        ok: true,
        service: "hacker-news-fa",
        time: new Date().toISOString(),
      });
    }

    if (url.pathname !== "/trigger") {
      return jsonResponse({ ok: false, error: "Not found" }, 404);
    }

    if (request.method !== "GET") return methodNotAllowed("GET");

    const configuredSecret = env.TRIGGER_SECRET?.trim() ?? "";
    if (!configuredSecret) {
      return jsonResponse(
        { ok: false, error: "TRIGGER_SECRET is not configured" },
        503,
      );
    }

    const providedSecret = getProvidedSecret(request, url);
    if (
      !providedSecret ||
      !constantTimeEqual(providedSecret.trim(), configuredSecret)
    ) {
      return jsonResponse(
        { ok: false, error: "Unauthorized" },
        401,
        { "www-authenticate": "Bearer" },
      );
    }

    const dryRun = ["1", "true", "yes"].includes(
      (url.searchParams.get("dry") ?? "").toLowerCase(),
    );

    try {
      const result = await runPipeline(env, {
        trigger: "http",
        dryRun,
        maxPosts: parseMaxPosts(url.searchParams.get("limit")),
      });
      return jsonResponse(result);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(
        JSON.stringify({ event: "trigger_run_failed", error: message }),
      );
      return jsonResponse({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runPipeline(env, { trigger: "cron" })
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: "cron_run_failed",
              error: getErrorMessage(error),
            }),
          );
        }),
    );
  },
} satisfies ExportedHandler<Env>;
