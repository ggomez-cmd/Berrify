import { boundAssetFetch, boundFetch } from "./bound-fetch";
import { handleEmptyBottleIdentifyPost } from "./empty-bottle-identify-post";
import { handleInvoiceExtractPost } from "./invoice-extract-post";
import { handleOcrPost } from "./ocr-post";
import { handleQbo } from "./qbo-manager";
import { handleQbwcManager } from "./qbwc-manager";
import { handleQbwcSoapPost } from "./qbwc-soap";
import { handleTelegramPost } from "./telegram-post";
import { handleWhatsAppPost } from "./whatsapp-post";

export type AssetFetcher = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export type WorkerEnv = {
  ASSETS: AssetFetcher;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ORG_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ORG_ID?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PUBLIC_APP_URL?: string;
  INTUIT_CLIENT_ID?: string;
  INTUIT_CLIENT_SECRET?: string;
  INTUIT_ENVIRONMENT?: string;
  GOOGLE_VISION_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  const type = headers.get("content-type") ?? "";
  headers.set("Content-Security-Policy", type.includes("text/html") ? HTML_CSP : API_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return withSecurityHeaders(Response.json(body, { status }));
}

function methodNotAllowed(allow: readonly string[]): Response {
  return withSecurityHeaders(
    new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: allow.join(", ") },
    }),
  );
}

function verifyWhatsApp(url: URL, env: WorkerEnv): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const expected = env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token === expected) {
    return withSecurityHeaders(new Response(challenge, { status: 200 }));
  }
  return withSecurityHeaders(new Response("Forbidden", { status: 403 }));
}

function apiPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function redirectToHttps(request: Request): Response | null {
  const url = new URL(request.url);
  const host = url.hostname;
  if (url.protocol !== "http:") return null;
  if (host === "localhost" || host === "127.0.0.1") return null;
  url.protocol = "https:";
  return new Response(null, {
    status: 301,
    headers: { Location: url.toString() },
  });
}

export async function handleApi(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch = boundFetch,
): Promise<Response> {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);

  if (path === "/api/health") {
    switch (request.method) {
      case "GET":
      case "HEAD":
        return json({ ok: true, service: "berrify" });
      default: {
        return methodNotAllowed(["GET", "HEAD"]);
      }
    }
  }

  if (path === "/api/webhooks/whatsapp") {
    switch (request.method) {
      case "GET":
        return verifyWhatsApp(url, env);
      case "POST":
        return withSecurityHeaders(await handleWhatsAppPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["GET", "POST"]);
      }
    }
  }

  if (path === "/api/webhooks/telegram") {
    switch (request.method) {
      case "POST":
        return withSecurityHeaders(await handleTelegramPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["POST"]);
      }
    }
  }

  if (path === "/api/ocr") {
    switch (request.method) {
      case "POST":
        return withSecurityHeaders(await handleOcrPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["POST"]);
      }
    }
  }

  if (path === "/api/invoice-extract") {
    switch (request.method) {
      case "POST":
        return withSecurityHeaders(await handleInvoiceExtractPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["POST"]);
      }
    }
  }

  if (path === "/api/empty-bottle-identify") {
    switch (request.method) {
      case "POST":
        return withSecurityHeaders(await handleEmptyBottleIdentifyPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["POST"]);
      }
    }
  }

  const qbo = await handleQbo(request, env, path, fetchImpl);
  if (qbo) return withSecurityHeaders(qbo);

  const qbwcManager = await handleQbwcManager(request, env, path, fetchImpl);
  if (qbwcManager) return withSecurityHeaders(qbwcManager);

  if (path === "/api/qbwc") {
    switch (request.method) {
      case "GET":
      case "HEAD":
        return withSecurityHeaders(
          new Response("Berrify QBWC service", {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
        );
      case "POST":
        return withSecurityHeaders(await handleQbwcSoapPost(request, env, fetchImpl));
      default: {
        return methodNotAllowed(["GET", "HEAD", "POST"]);
      }
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const httpsRedirect = redirectToHttps(request);
    if (httpsRedirect) return httpsRedirect;
    const path = apiPath(new URL(request.url).pathname);
    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return withSecurityHeaders(await boundAssetFetch(env.ASSETS, request));
  },
};
