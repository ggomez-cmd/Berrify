import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_BOTTLE_AWAIT_PHOTO,
  EMPTY_BOTTLE_IDENTIFY_UNAVAILABLE,
  EMPTY_BOTTLE_TEXT_HELP,
  emptyCallbackData,
} from "../src/lib/empty-bottle";
import { VISION_IMAGE_BYTE_BUDGET, VISION_LONG_EDGE } from "../src/lib/invoice-image";
import { bytesToBase64, VISION_IMAGE_TOO_LARGE } from "../src/lib/vision-fit";
import { TELEGRAM_SECRET_HEADER } from "../src/lib/telegram-webhook";
import { signWhatsAppBody } from "../src/lib/whatsapp-webhook";
import worker, { handleApi, redirectToHttps, type WorkerEnv } from "./index";

const env: WorkerEnv = {
  ASSETS: { fetch: async () => new Response("assets") },
  WHATSAPP_VERIFY_TOKEN: "demo-verify",
};

const ingestEnv: WorkerEnv = {
  ...env,
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_ACCESS_TOKEN: "graph-token",
  WHATSAPP_PHONE_NUMBER_ID: "123456",
  WHATSAPP_ORG_ID: "org-1",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_WEBHOOK_SECRET: "hook-secret",
  TELEGRAM_ORG_ID: "org-1",
};

function api(
  path: string,
  init?: RequestInit,
  workerEnv: WorkerEnv = env,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  return handleApi(new Request(`https://berrify.example${path}`, init), workerEnv, fetchImpl);
}

const TINY_JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQ";

const ocrEnv: WorkerEnv = {
  ...env,
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

function mockAuthFetch(inner?: typeof fetch): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://example.supabase.co/auth/v1/user") {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer user-token") {
        return Response.json({ id: "user-1" });
      }
      return new Response("Unauthorized", { status: 401 });
    }
    if (inner) return inner(input, init);
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  };
  return fetchImpl;
}

function ocrInit(body: string, extra?: RequestInit): RequestInit {
  return {
    method: "POST",
    ...extra,
    headers: {
      Origin: "https://berrify.example",
      Authorization: "Bearer user-token",
      "Content-Type": "application/json",
      ...(extra?.headers ?? {}),
    },
    body,
  };
}

const IMAGE_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "123456" },
            messages: [
              {
                id: "wamid.HBgLTEST",
                from: "17875550100",
                type: "image",
                image: {
                  id: "MEDIA_1",
                  caption: "Semilla factura",
                  mime_type: "image/jpeg",
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

const TELEGRAM_PHOTO_BODY = JSON.stringify({
  update_id: 1001,
  message: {
    message_id: 42,
    caption: "Semilla factura",
    from: { id: 777, username: "cook" },
    chat: { id: -100 },
    photo: [
      { file_id: "SMALL", file_size: 100 },
      { file_id: "FILE_1", file_size: 9000 },
    ],
  },
});

const TELEGRAM_TEXT_BODY = JSON.stringify({
  update_id: 1002,
  message: {
    message_id: 43,
    chat: { id: -100 },
    text: "hello",
  },
});

const TELEGRAM_EMPTY_PHOTO_BODY = JSON.stringify({
  update_id: 1004,
  message: {
    message_id: 45,
    caption: "empty Semilla",
    from: { id: 777, username: "cook" },
    chat: { id: -100 },
    photo: [
      { file_id: "SMALL", file_size: 100 },
      { file_id: "FILE_1", file_size: 9000 },
    ],
  },
});

const EVENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const TELEGRAM_EMPTY_OK_BODY = JSON.stringify({
  update_id: 1005,
  callback_query: {
    id: "cb-ok",
    data: emptyCallbackData(true, EVENT_ID),
    message: { chat: { id: -100 } },
  },
});

const TELEGRAM_EMPTY_NO_BODY = JSON.stringify({
  update_id: 1006,
  callback_query: {
    id: "cb-no",
    data: emptyCallbackData(false, EVENT_ID),
    message: { chat: { id: -100 } },
  },
});

const TELEGRAM_EMPTY_COMMAND_BODY = JSON.stringify({
  update_id: 1007,
  message: {
    message_id: 46,
    chat: { id: -100 },
    text: "/empty",
  },
});

const TELEGRAM_DOCUMENT_BODY = JSON.stringify({
  update_id: 1003,
  message: {
    message_id: 44,
    caption: "Semilla factura",
    from: { id: 777, username: "cook" },
    chat: { id: -100 },
    document: { file_id: "FILE_1", mime_type: "image/jpeg", file_name: "bill.jpg" },
  },
});

const TEXT_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "123456" },
            messages: [
              {
                id: "wamid.TEXT",
                from: "17875550100",
                type: "text",
                text: { body: "hello" },
              },
            ],
          },
        },
      ],
    },
  ],
});

type PendingRow = { org_id: string; chat_id: string; hint: string; expires_at: string };

function handlePendingRest(
  url: string,
  method: string,
  body: unknown,
  pendingRows: Map<string, PendingRow>,
): Response | null {
  if (!url.includes("/rest/v1/empty_bottle_pending")) return null;
  if (method === "POST") {
    const row = body as PendingRow;
    pendingRows.set(`${row.org_id}:${row.chat_id}`, row);
    return new Response(null, { status: 201 });
  }
  if (method === "DELETE") {
    const parsed = new URL(url);
    const orgId = parsed.searchParams.get("org_id")?.replace(/^eq\./, "") ?? "";
    const chatId = parsed.searchParams.get("chat_id")?.replace(/^eq\./, "") ?? "";
    const key = `${orgId}:${chatId}`;
    const row = pendingRows.get(key);
    pendingRows.delete(key);
    return Response.json(row ? [row] : []);
  }
  throw new Error(`unexpected pending ${method} ${url}`);
}

function mockIngestFetch(options?: { alreadyExists?: boolean; insertStatus?: number }) {
  const inserted: unknown[] = [];
  const pendingRows = new Map<string, PendingRow>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const pending = handlePendingRest(url, method, body, pendingRows);
    if (pending) return pending;
    if (url === "https://graph.facebook.com/v21.0/MEDIA_1") {
      return Response.json({
        url: "https://lookaside.fbsbx.com/file",
        mime_type: "image/jpeg",
      });
    }
    if (url === "https://lookaside.fbsbx.com/file") {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url === "https://api.telegram.org/botbot-token/getFile?file_id=FILE_1") {
      return Response.json({
        ok: true,
        result: { file_path: "photos/bill.jpg", file_size: 3 },
      });
    }
    if (url === "https://api.telegram.org/file/botbot-token/photos/bill.jpg") {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url.includes("/rest/v1/restaurants")) {
      return Response.json([
        { id: "r-semilla", name: "Semilla", qbo_company_name: "Semilla", slug: "semilla" },
      ]);
    }
    if (url.includes("/rest/v1/restaurant_aliases")) {
      return Response.json([
        { restaurant_id: "r-semilla", match_kind: "caption", match_text: "semilla" },
      ]);
    }
    if (url.includes("/rest/v1/quickbooks_vendors") && method === "GET") {
      return Response.json([]);
    }
    if (url.includes("/rest/v1/invoices") && method === "GET") {
      return Response.json(options?.alreadyExists ? [{ id: "inv-1" }] : []);
    }
    if (url.includes("/rest/v1/invoices") && method === "POST") {
      inserted.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(null, { status: options?.insertStatus ?? 201 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { fetchImpl, inserted };
}

function mockEmptyFetch(options?: {
  eventStatus?: "pending" | "confirmed" | "cancelled";
  claim?: boolean;
  geminiLines?: number;
  geminiFirstPayload?: unknown;
  pendingRows?: Map<string, PendingRow>;
}) {
  const invoices: unknown[] = [];
  const movements: unknown[] = [];
  const telegramCalls: Array<{ url: string; body: unknown }> = [];
  const rpcCalls: Array<{ url: string; body: unknown }> = [];
  const lineInserts: unknown[] = [];
  const geminiCalls: unknown[] = [];
  const pendingRows = options?.pendingRows ?? new Map<string, PendingRow>();
  const events: Array<Record<string, unknown>> = [
    {
      id: EVENT_ID,
      org_id: "org-1",
      telegram_message_id: "-100:45",
      chat_id: "-100",
      restaurant_id: "r-semilla",
      proposed_item_id: "i-rum",
      proposed_label: "1 bottle",
      status: options?.eventStatus ?? "pending",
      vision_count: null,
      gemini_count: 1,
    },
  ];
  let eventByMessage: Record<string, unknown> | null = null;
  const lineCount = options?.geminiLines ?? 1;
  const geminiPayload = {
    bottle_count: lineCount,
    lines: Array.from({ length: lineCount }, (_, index) => ({
      index: index + 1,
      label: index === 0 ? "Rum" : `Bottle ${index + 1}`,
      sku: index === 0 ? "BV-EB-RUM" : null,
      qty: 1,
    })),
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const pending = handlePendingRest(url, method, body, pendingRows);
    if (pending) return pending;
    if (url === "https://api.telegram.org/botbot-token/getFile?file_id=FILE_1") {
      return Response.json({ ok: true, result: { file_path: "photos/bill.jpg", file_size: 3 } });
    }
    if (url === "https://api.telegram.org/file/botbot-token/photos/bill.jpg") {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }
    if (url.startsWith("https://api.telegram.org/botbot-token/")) {
      telegramCalls.push({ url, body });
      return Response.json({ ok: true });
    }
    if (url.includes("vision.googleapis.com")) {
      return Response.json({
        responses: [
          {
            localizedObjectAnnotations: Array.from({ length: lineCount }, (_, index) => ({
              name: "Bottle",
              score: 0.9,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.05 + index * 0.07, y: 0.2 },
                  { x: 0.1 + index * 0.07, y: 0.2 },
                  { x: 0.1 + index * 0.07, y: 0.7 },
                  { x: 0.05 + index * 0.07, y: 0.7 },
                ],
              },
            })),
            fullTextAnnotation: { text: "Rum" },
          },
        ],
      });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCalls.push(body);
      const payload = geminiCalls.length === 1 && options?.geminiFirstPayload != null
        ? options.geminiFirstPayload
        : geminiPayload;
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      });
    }
    if (url.includes("/rest/v1/restaurants")) {
      return Response.json([{ id: "r-semilla", name: "Semilla", qbo_company_name: "Semilla", slug: "semilla" }]);
    }
    if (url.includes("/rest/v1/restaurant_aliases")) {
      return Response.json([{ restaurant_id: "r-semilla", match_kind: "caption", match_text: "semilla" }]);
    }
    if (url.includes("/rest/v1/organizations")) {
      return Response.json([{ name: "Pacifico Kitchen" }]);
    }
    if (url.includes("/rest/v1/memberships")) {
      return Response.json([{ org_id: "org-1", role: "manager" }]);
    }
    if (url.includes("/rest/v1/inventory_items") && method === "GET") {
      return Response.json([
        { id: "i-rum", sku: "BV-EB-RUM", name: "Rum" },
        { id: "i-unknown", sku: "BV-EB-UNKNOWN", name: "Unknown liquor" },
      ]);
    }
    if (url.includes("/rest/v1/inventory_items") && method === "POST") {
      const created = { id: `i-${String(body.sku).toLowerCase()}`, sku: body.sku, name: body.name };
      return Response.json([created], { status: 201 });
    }
    if (url.includes("/rest/v1/rpc/confirm_empty_bottle")) {
      if (options?.claim === false || options?.eventStatus === "confirmed") {
        rpcCalls.push({ url, body });
        return Response.json({ ok: true, already_handled: true, status: "confirmed", debited: 0 });
      }
      rpcCalls.push({ url, body });
      movements.push({ debited: lineCount });
      return Response.json({ ok: true, already_handled: false, status: "confirmed", debited: lineCount });
    }
    if (url.includes("/rest/v1/rpc/cancel_empty_bottle")) {
      rpcCalls.push({ url, body });
      return Response.json({ ok: true, already_handled: false, status: "cancelled" });
    }
    if (url.includes("/rest/v1/empty_bottle_lines") && method === "GET") {
      return Response.json([
        {
          id: "line-1",
          event_id: EVENT_ID,
          org_id: "org-1",
          proposed_item_id: "i-rum",
          proposed_label: "Rum",
          qty: 1,
          sort: 0,
        },
      ]);
    }
    if (url.includes("/rest/v1/empty_bottle_lines") && method === "POST") {
      lineInserts.push(body);
      return Response.json(Array.isArray(body) ? body : [body], { status: 201 });
    }
    if (url.includes("/rest/v1/empty_bottle_events") && method === "GET") {
      if (url.includes("telegram_message_id=")) {
        return Response.json(eventByMessage ? [eventByMessage] : []);
      }
      return Response.json(events);
    }
    if (url.includes("/rest/v1/empty_bottle_events") && method === "POST") {
      const created = { id: EVENT_ID, status: "pending", ...body };
      eventByMessage = created;
      return Response.json([created], { status: 201 });
    }
    if (url.includes("/rest/v1/empty_bottle_events") && method === "PATCH") {
      if (options?.claim === false || (events[0]?.status !== "pending" && options?.eventStatus)) {
        return Response.json([]);
      }
      events[0] = { ...events[0], ...body };
      return Response.json(events);
    }
    if (url.includes("/rest/v1/stock_movements") && method === "POST") {
      movements.push(body);
      return Response.json([body], { status: 201 });
    }
    if (url.includes("/rest/v1/invoices") && method === "POST") {
      invoices.push(body);
      return new Response(null, { status: 201 });
    }
    if (url.includes("/rest/v1/invoices") && method === "GET") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { fetchImpl, invoices, movements, telegramCalls, rpcCalls, lineInserts, geminiCalls, getEvent: () => eventByMessage };
}

describe("Worker API", () => {
  it("returns health JSON", async () => {
    const response = await api("/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "berrify" });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("treats a trailing slash as the same health route", async () => {
    const response = await api("/api/health/");
    expect(response.status).toBe(200);
  });

  it("rejects unknown API paths", async () => {
    const response = await api("/api/nope");
    expect(response.status).toBe(404);
  });

  it("returns a short QBWC service body on GET", async () => {
    const response = await api("/api/qbwc");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(await response.text()).toBe("Berrify QBWC service");
  });

  it("answers serverVersion as SOAP XML", async () => {
    const response = await api("/api/qbwc", {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><serverVersion></serverVersion></soap:Body>
</soap:Envelope>`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/xml");
    const xml = await response.text();
    expect(xml).toContain("<serverVersionResult>1.0.0</serverVersionResult>");
    expect(xml).not.toContain("{");
  });

  it("verifies the WhatsApp webhook challenge", async () => {
    const response = await api(
      "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=demo-verify&hub.challenge=abc123",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });

  it("rejects a bad WhatsApp verify token", async () => {
    const response = await api(
      "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123",
    );
    expect(response.status).toBe(403);
  });

  it("returns 503 for WhatsApp POSTs when ingest secrets are missing", async () => {
    const response = await api("/api/webhooks/whatsapp", { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects a WhatsApp POST with a bad signature", async () => {
    const response = await api(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: { "X-Hub-Signature-256": "sha256=deadbeef" },
        body: IMAGE_BODY,
      },
      ingestEnv,
    );
    expect(response.status).toBe(403);
  });

  it("acks text-only WhatsApp POSTs without inserting", async () => {
    const { fetchImpl, inserted } = mockIngestFetch();
    const signature = await signWhatsAppBody(TEXT_BODY, "app-secret");
    const response = await api(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: TEXT_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 0,
      skipped: 0,
      errors: [],
    });
    expect(inserted).toEqual([]);
  });

  it("downloads a WhatsApp image and inserts a received invoice", async () => {
    const { fetchImpl, inserted } = mockIngestFetch();
    const signature = await signWhatsAppBody(IMAGE_BODY, "app-secret");
    const response = await api(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: IMAGE_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 1,
      skipped: 0,
      errors: [],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      org_id: "org-1",
      restaurant_id: "r-semilla",
      status: "received",
      source: "whatsapp",
      whatsapp_message_id: "wamid.HBgLTEST",
      caption: "Semilla factura",
      ocr_text: null,
    });
  });

  it("returns 503 for Telegram POSTs when ingest secrets are missing", async () => {
    const response = await api("/api/webhooks/telegram", { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects a Telegram POST with a bad secret header", async () => {
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "wrong" },
        body: TELEGRAM_PHOTO_BODY,
      },
      ingestEnv,
    );
    expect(response.status).toBe(403);
  });

  it("acks text-only Telegram POSTs with a help reply and does not invoice", async () => {
    const { fetchImpl, invoices, telegramCalls } = mockEmptyFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_TEXT_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      ingested: 0,
      skipped: 0,
      errors: [],
      ignored: "text_help",
    });
    expect(JSON.stringify(payload)).not.toContain("bot-token");
    expect(JSON.stringify(payload)).not.toContain("hook-secret");
    expect(invoices).toEqual([]);
    expect(
      telegramCalls.some((call) => {
        const body = call.body as { text?: string; reply_to_message_id?: number };
        return (
          String(call.url).includes("/sendMessage") &&
          body.text === EMPTY_BOTTLE_TEXT_HELP &&
          body.reply_to_message_id === 43
        );
      }),
    ).toBe(true);
  });

  it("downloads a Telegram image document and inserts a received invoice", async () => {
    const { fetchImpl, inserted } = mockIngestFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_DOCUMENT_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 1,
      skipped: 0,
      errors: [],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      source: "telegram",
      telegram_message_id: "-100:44",
      caption: "Semilla factura",
    });
  });

  it("returns 502 when Telegram getFile fails for every photo", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/getFile")) {
        return Response.json({ ok: false, description: "Bad Request: file is too big" });
      }
      if (url.includes("/rest/v1/empty_bottle_pending")) {
        return Response.json([]);
      }
      if (url.includes("/rest/v1/restaurants") || url.includes("/rest/v1/restaurant_aliases")) {
        return Response.json([]);
      }
      if (url.includes("/rest/v1/invoices")) {
        return Response.json([]);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      ingested: 0,
      skipped: 1,
      errors: ["-100:42: Bad Request: file is too big"],
    });
  });

  it("downloads a Telegram photo and inserts a received invoice", async () => {
    const { fetchImpl, inserted } = mockIngestFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 1,
      skipped: 0,
      errors: [],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      org_id: "org-1",
      restaurant_id: "r-semilla",
      status: "received",
      source: "telegram",
      telegram_message_id: "-100:42",
      caption: "Semilla factura",
      ocr_text: null,
    });
  });

  it("never invoices an empty-bottle photo and replies when Gemini is missing", async () => {
    const { fetchImpl, invoices, telegramCalls } = mockEmptyFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_PHOTO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ingested: 0,
      empty: "identify_unavailable",
    });
    expect(invoices).toEqual([]);
    expect(telegramCalls.some((call) => JSON.stringify(call.body).includes(EMPTY_BOTTLE_IDENTIFY_UNAVAILABLE))).toBe(
      true,
    );
  });

  it("identifies an empty bottle and asks for confirm without invoicing", async () => {
    const { fetchImpl, invoices, telegramCalls, lineInserts, getEvent } = mockEmptyFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_PHOTO_BODY,
      },
      { ...ingestEnv, GEMINI_API_KEY: "gemini-key" },
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ingested: 0, empty: "awaiting_confirm" });
    expect(invoices).toEqual([]);
    expect(getEvent()).toMatchObject({
      source: "telegram",
      image_mime: "image/jpeg",
    });
    expect(String((getEvent() as { image_data?: string } | null)?.image_data ?? "")).toContain("data:image/jpeg");
    expect(lineInserts).toHaveLength(1);
    expect(telegramCalls.some((call) => JSON.stringify(call.body).includes("Vision"))).toBe(true);
    expect(telegramCalls.some((call) => String(call.url).includes("sendMessage"))).toBe(true);
  });

  it("still invoices an unmarked Telegram photo", async () => {
    const { fetchImpl, inserted } = mockIngestFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });

  it("confirms an empty bottle once and ignores a second confirm", async () => {
    const first = mockEmptyFetch();
    const confirmInit = {
      method: "POST" as const,
      headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
      body: TELEGRAM_EMPTY_OK_BODY,
    };
    const confirmed = await api("/api/webhooks/telegram", confirmInit, ingestEnv, first.fetchImpl);
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({ empty: "confirmed" });
    expect(first.rpcCalls).toHaveLength(1);
    expect(first.movements).toEqual([{ debited: 1 }]);

    const second = mockEmptyFetch({ eventStatus: "confirmed", claim: false });
    const again = await api("/api/webhooks/telegram", confirmInit, ingestEnv, second.fetchImpl);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ empty: "already_handled" });
    expect(second.movements).toEqual([]);
  });

  it("cancels an empty bottle without a stock movement", async () => {
    const { fetchImpl, movements } = mockEmptyFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_NO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ empty: "cancelled" });
    expect(movements).toEqual([]);
  });

  it("uses a pending /empty command for the next photo", async () => {
    const { fetchImpl, invoices, telegramCalls } = mockEmptyFetch();
    const command = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_COMMAND_BODY,
      },
      { ...ingestEnv, GEMINI_API_KEY: "gemini-key" },
      fetchImpl,
    );
    expect(command.status).toBe(200);
    await expect(command.json()).resolves.toMatchObject({ empty: "awaiting_photo" });
    expect(
      telegramCalls.some(
        (call) =>
          String(call.url).includes("/sendMessage") &&
          JSON.stringify(call.body).includes(EMPTY_BOTTLE_AWAIT_PHOTO) &&
          (call.body as { reply_to_message_id?: number }).reply_to_message_id === 46,
      ),
    ).toBe(true);

    const photo = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      { ...ingestEnv, GEMINI_API_KEY: "gemini-key" },
      fetchImpl,
    );
    expect(photo.status).toBe(200);
    await expect(photo.json()).resolves.toMatchObject({ empty: "awaiting_confirm" });
    expect(invoices).toEqual([]);
  });

  it("keeps /empty pending across simulated Worker isolates", async () => {
    const pendingRows = new Map<string, PendingRow>();
    const isolateA = mockEmptyFetch({ pendingRows });
    const isolateB = mockEmptyFetch({ pendingRows });
    const command = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_COMMAND_BODY,
      },
      { ...ingestEnv, GEMINI_API_KEY: "gemini-key" },
      isolateA.fetchImpl,
    );
    expect(command.status).toBe(200);
    await expect(command.json()).resolves.toMatchObject({ empty: "awaiting_photo" });

    const photo = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      { ...ingestEnv, GEMINI_API_KEY: "gemini-key" },
      isolateB.fetchImpl,
    );
    expect(photo.status).toBe(200);
    await expect(photo.json()).resolves.toMatchObject({ empty: "awaiting_confirm" });
    expect(isolateB.invoices).toEqual([]);
  });

  it("replies to /empty@berrify.bot and fails sendMessage when Telegram ok is false", async () => {
    const dotted = mockEmptyFetch();
    const dottedCommand = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: JSON.stringify({
          update_id: 1008,
          message: { message_id: 47, chat: { id: -100 }, text: "/empty@berrify.bot" },
        }),
      },
      ingestEnv,
      dotted.fetchImpl,
    );
    expect(dottedCommand.status).toBe(200);
    await expect(dottedCommand.json()).resolves.toMatchObject({ empty: "awaiting_photo" });
    expect(
      dotted.telegramCalls.some((call) => JSON.stringify(call.body).includes(EMPTY_BOTTLE_AWAIT_PHOTO)),
    ).toBe(true);

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/sendMessage")) {
        return Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" });
      }
      return dotted.fetchImpl(input, init);
    };
    const blocked = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_EMPTY_COMMAND_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(blocked.status).toBe(200);
    const payload = (await blocked.json()) as { errors?: string[]; empty?: string };
    expect(payload.empty).toBe("awaiting_photo");
    expect(payload.errors?.join(" ")).toContain("Forbidden: bot was blocked by the user");
    expect(JSON.stringify(payload)).not.toContain("bot-token");
  });

  it("acks Hello with 200 when sendMessage is ok false so Telegram keeps the webhook", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/sendMessage")) {
        return Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_TEXT_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ignored?: string; errors?: string[] };
    expect(payload.ignored).toBe("text_help");
    expect(payload.errors?.join(" ")).toContain("Forbidden: bot was blocked by the user");
  });

  it("treats an entities-only /empty payload as awaiting_photo", async () => {
    const { fetchImpl, invoices, telegramCalls } = mockEmptyFetch();
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: JSON.stringify({
          update_id: 1009,
          message: {
            message_id: 48,
            chat: { id: -100 },
            text: "xx/emptyyy",
            entities: [{ type: "bot_command", offset: 2, length: 6 }],
          },
        }),
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ empty: "awaiting_photo" });
    expect(invoices).toEqual([]);
    expect(
      telegramCalls.some((call) => {
        const body = call.body as { text?: string; reply_to_message_id?: number };
        return (
          String(call.url).includes("/sendMessage") &&
          body.text === EMPTY_BOTTLE_AWAIT_PHOTO &&
          body.reply_to_message_id === 48
        );
      }),
    ).toBe(true);
  });

  it("treats a duplicate Telegram message id as success", async () => {
    const { fetchImpl, inserted } = mockIngestFetch({ alreadyExists: true });
    const response = await api(
      "/api/webhooks/telegram",
      {
        method: "POST",
        headers: { [TELEGRAM_SECRET_HEADER]: "hook-secret" },
        body: TELEGRAM_PHOTO_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 0,
      skipped: 1,
      errors: [],
    });
    expect(inserted).toEqual([]);
  });

  it("treats a duplicate WhatsApp message id as success", async () => {
    const { fetchImpl, inserted } = mockIngestFetch({ alreadyExists: true });
    const signature = await signWhatsAppBody(IMAGE_BODY, "app-secret");
    const response = await api(
      "/api/webhooks/whatsapp",
      {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: IMAGE_BODY,
      },
      ingestEnv,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ingested: 0,
      skipped: 1,
      errors: [],
    });
    expect(inserted).toEqual([]);
  });

  it("rejects non-GET health requests", async () => {
    const response = await api("/api/health", { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("returns 503 for OCR when the Vision key is missing", async () => {
    const response = await api(
      "/api/ocr",
      ocrInit(JSON.stringify({ image: TINY_JPEG_DATA_URL })),
      ocrEnv,
      mockAuthFetch(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Vision OCR is not configured" });
  });

  it("returns 400 for OCR with invalid JSON", async () => {
    const response = await api(
      "/api/ocr",
      ocrInit("{", { headers: { Origin: "https://berrify.example", Authorization: "Bearer user-token" } }),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("returns Vision text when DOCUMENT_TEXT_DETECTION succeeds", async () => {
    const visionFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      expect(url).toMatch(/^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=vision-key$/);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        requests: { features: { type: string }[]; imageContext: { languageHints: string[] } }[];
      };
      expect(body.requests[0]?.features[0]?.type).toBe("DOCUMENT_TEXT_DETECTION");
      expect(body.requests[0]?.imageContext.languageHints).toEqual(["es", "en"]);
      return Response.json({
        responses: [
          {
            fullTextAnnotation: {
              text: "FACTURA 12.00",
              pages: [{ confidence: 0.91 }],
            },
          },
        ],
      });
    };
    const response = await api(
      "/api/ocr",
      ocrInit(JSON.stringify({ image: TINY_JPEG_DATA_URL })),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(visionFetch),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "FACTURA 12.00", confidence: 91 });
  });

  it("posts a long-edge JPEG to Vision when the upload is a wide photo", async () => {
    const width = 2400;
    const height = 16;
    const pixels = new Uint8Array(width * height * 4);
    pixels.fill(180);
    const original = new Uint8Array(encodeJpeg({ data: pixels, width, height }, 75).data);
    const image = `data:image/jpeg;base64,${bytesToBase64(original)}`;
    let visionCalls = 0;
    const visionFetch: typeof fetch = async (input, init) => {
      visionCalls += 1;
      expect(String(input)).toMatch(/^https:\/\/vision\.googleapis\.com\/v1\/images:annotate\?key=vision-key$/);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        requests: { image: { content: string }; features: { type: string }[] }[];
      };
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0]?.features[0]?.type).toBe("DOCUMENT_TEXT_DETECTION");
      const sent = Uint8Array.from(atob(body.requests[0].image.content), (char) => char.charCodeAt(0));
      const decoded = decodeJpeg(sent, { useTArray: true });
      expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(VISION_LONG_EDGE);
      expect(decoded.width).not.toBe(width);
      return Response.json({
        responses: [{ fullTextAnnotation: { text: "FACTURA 182.86", pages: [{ confidence: 0.8 }] } }],
      });
    };
    const response = await api(
      "/api/ocr",
      ocrInit(JSON.stringify({ image })),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(visionFetch),
    );
    expect(response.status).toBe(200);
    expect(visionCalls).toBe(1);
    await expect(response.json()).resolves.toEqual({ text: "FACTURA 182.86", confidence: 80 });
  });

  it("does not call Vision when the upload cannot be fit under the JSON cap", async () => {
    const bytes = new Uint8Array(VISION_IMAGE_BYTE_BUDGET + 1);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    const image = `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
    const visionFetch = vi.fn(async () => Response.json({ responses: [] }));
    const response = await api(
      "/api/ocr",
      ocrInit(JSON.stringify({ image })),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(visionFetch),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: VISION_IMAGE_TOO_LARGE });
    expect(visionFetch).not.toHaveBeenCalled();
  });

  it("rejects OCR when the image is an https URL instead of a raster data URL", async () => {
    const response = await api(
      "/api/ocr",
      ocrInit(
        JSON.stringify({
          image: "https://example.supabase.co/storage/v1/object/public/bills/a.jpg",
        }),
      ),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "image must be a raster data URL" });
  });

  it("rejects OCR when the image is an octet-stream data URL instead of a raster data URL", async () => {
    const response = await api(
      "/api/ocr",
      ocrInit(JSON.stringify({ image: "data:application/octet-stream;base64,/9j/4AAQ" })),
      { ...ocrEnv, GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "image must be a raster data URL" });
  });

  it("rejects unauthenticated OCR calls", async () => {
    const response = await api("/api/ocr", {
      method: "POST",
      headers: { Origin: "https://berrify.example", "Content-Type": "application/json" },
      body: JSON.stringify({ image: TINY_JPEG_DATA_URL }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 503 for invoice extract when the Gemini key is missing", async () => {
    const response = await api(
      "/api/invoice-extract",
      ocrInit(JSON.stringify({ ocr_text: "FACTURA 12.00" })),
      ocrEnv,
      mockAuthFetch(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Gemini extract is not configured" });
  });

  it("returns 400 for invoice extract with invalid JSON", async () => {
    const response = await api(
      "/api/invoice-extract",
      ocrInit("{", {
        headers: { Origin: "https://berrify.example", Authorization: "Bearer user-token" },
      }),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("returns Gemini invoices when generateContent succeeds", async () => {
    const geminiFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      expect(url).toMatch(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent\?key=gemini-key$/,
      );
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: unknown;
        generationConfig?: { responseMimeType?: string };
        contents?: { parts?: unknown[] }[];
      };
      expect(body.tools).toBeUndefined();
      expect(body.generationConfig?.responseMimeType).toBe("application/json");
      expect(JSON.stringify(body)).not.toContain("googleSearch");
      expect(JSON.stringify(init?.body)).not.toMatch(/data:image/);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    invoices: [
                      {
                        vendor_name: "Ballester",
                        qbo_vendor_name: "Ballester Hermanos Inc",
                        supplier_id: null,
                        invoice_number: "123",
                        invoice_date: "2026-08-13",
                        due_date: null,
                        terms: "Net 30",
                        subtotal: 757.56,
                        tax: 0,
                        total: 757.56,
                        lines: [],
                        expenses: [{ account: "50000 · Food Purchases", amount: 757.56, memo: "Food" }],
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      });
    };
    const response = await api(
      "/api/invoice-extract",
      ocrInit(
        JSON.stringify({
          ocr_text: "BALLESTER HERMANOS NUM. FACTURA 123 TOTAL $757.56 extra padding text here",
          confidence: 92,
        }),
      ),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(geminiFetch),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      engine: "gemini",
      invoices: [
        expect.objectContaining({
          vendor_name: "Ballester",
          total: 757.56,
          invoice_number: "123",
        }),
      ],
    });
  });

  it("accepts Gemini SKU rows with only a description", async () => {
    const geminiFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        generationConfig?: { responseSchema?: { properties?: { invoices?: { items?: { properties?: { lines?: { items?: { required?: string[] } } } } } } } };
      };
      expect(
        body.generationConfig?.responseSchema?.properties?.invoices?.items?.properties?.lines?.items?.required,
      ).toEqual(["description"]);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    invoices: [
                      {
                        vendor_name: "Northwestern Selecta",
                        qbo_vendor_name: "Northwestern Selecta",
                        terms: "Net 7",
                        subtotal: 0,
                        tax: 0,
                        total: 446.27,
                        lines: [{ description: "BOBBY VEAL SCALLOPINI" }],
                        expenses: [],
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      });
    };
    const response = await api(
      "/api/invoice-extract",
      ocrInit(JSON.stringify({ ocr_text: "NORTHWESTERN SELECTA INVOICE TOTAL 446.27" })),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(geminiFetch),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      invoices: Array<{ lines: Array<{ description: string; amount: number }>; total: number }>;
    };
    expect(payload.invoices[0]?.total).toBe(446.27);
    expect(payload.invoices[0]?.lines).toEqual([
      expect.objectContaining({ description: "BOBBY VEAL SCALLOPINI", amount: 0 }),
    ]);
  });

  it("forwards a raster photo to Gemini even when OCR is not thin", async () => {
    const geminiFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: Array<{ parts?: Array<{ inline_data?: { mime_type?: string } }> }>;
      };
      expect(body.contents?.[0]?.parts?.some((part) => part.inline_data?.mime_type === "image/jpeg")).toBe(
        true,
      );
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    invoices: [
                      {
                        vendor_name: "Northwestern Selecta",
                        qbo_vendor_name: "Northwestern Selecta",
                        terms: "Net 7",
                        subtotal: 446.27,
                        tax: 0,
                        total: 446.27,
                        lines: [],
                        expenses: [],
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      });
    };
    const response = await api(
      "/api/invoice-extract",
      ocrInit(
        JSON.stringify({
          ocr_text: "BALLESTER HERMANOS NUM. FACTURA 123 TOTAL $757.56 extra padding text here",
          confidence: 92,
          image: TINY_JPEG_DATA_URL,
        }),
      ),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(geminiFetch),
    );
    expect(response.status).toBe(200);
  });

  it("rejects invoice extract images that are not raster data URLs", async () => {
    const response = await api(
      "/api/invoice-extract",
      ocrInit(
        JSON.stringify({
          ocr_text: "BALLESTER HERMANOS NUM. FACTURA 123 TOTAL $757.56 extra padding text here",
          image: "https://example.supabase.co/storage/v1/object/public/bills/a.jpg",
        }),
      ),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "image must be a raster data URL" });
  });

  it("rejects unauthenticated invoice extract calls", async () => {
    const response = await api("/api/invoice-extract", {
      method: "POST",
      headers: { Origin: "https://berrify.example", "Content-Type": "application/json" },
      body: JSON.stringify({ ocr_text: "FACTURA" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 503 for empty-bottle identify when Gemini is missing", async () => {
    const response = await api(
      "/api/empty-bottle-identify",
      ocrInit(JSON.stringify({ image: TINY_JPEG_DATA_URL })),
      ocrEnv,
      mockAuthFetch(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Empty-bottle identify is unavailable" });
  });

  it("rejects unauthenticated empty-bottle identify calls", async () => {
    const response = await api("/api/empty-bottle-identify", {
      method: "POST",
      headers: { Origin: "https://berrify.example", "Content-Type": "application/json" },
      body: JSON.stringify({ image: TINY_JPEG_DATA_URL }),
    });
    expect(response.status).toBe(401);
  });

  it("stores an app empty-bottle event with lines when Gemini is configured", async () => {
    const { fetchImpl, getEvent, lineInserts } = mockEmptyFetch({ geminiLines: 11 });
    const response = await api(
      "/api/empty-bottle-identify",
      ocrInit(JSON.stringify({ image: TINY_JPEG_DATA_URL, restaurant_id: "r-semilla" })),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key" },
      mockAuthFetch(fetchImpl),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      event_id: EVENT_ID,
      gemini_count: 11,
      proposed_label: "11 bottles",
    });
    expect(getEvent()).toMatchObject({ source: "app", restaurant_id: "r-semilla" });
    expect(lineInserts[0]).toHaveLength(11);
  });

  it("retries Gemini once when the first line count is far from Vision", async () => {
    const { fetchImpl, geminiCalls } = mockEmptyFetch({
      geminiLines: 11,
      geminiFirstPayload: {
        bottle_count: 3,
        lines: [
          { index: 1, label: "Rum", sku: "BV-EB-RUM", qty: 1 },
          { index: 2, label: "Wine", sku: "BV-EB-WINE", qty: 1 },
          { index: 3, label: "Gin", sku: "BV-EB-GIN", qty: 1 },
        ],
      },
    });
    const response = await api(
      "/api/empty-bottle-identify",
      ocrInit(JSON.stringify({ image: TINY_JPEG_DATA_URL })),
      { ...ocrEnv, GEMINI_API_KEY: "gemini-key", GOOGLE_VISION_API_KEY: "vision-key" },
      mockAuthFetch(fetchImpl),
    );
    expect(response.status).toBe(200);
    expect(geminiCalls).toHaveLength(2);
    expect(JSON.stringify(geminiCalls[1])).toContain("Return exactly 11 lines");
  });
});

describe("HTTPS redirect", () => {
  it("upgrades public http requests", () => {
    const response = redirectToHttps(new Request("http://berrify.app/login"));
    expect(response?.status).toBe(301);
    expect(response?.headers.get("Location")).toBe("https://berrify.app/login");
  });

  it("leaves localhost http alone", () => {
    expect(redirectToHttps(new Request("http://localhost:5180/"))).toBeNull();
  });

  it("runs before asset fetch", async () => {
    const response = await worker.fetch(new Request("http://berrify.app/"), env);
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://berrify.app/");
  });
});
