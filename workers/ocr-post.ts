import { MAX_INVOICE_IMAGE_BYTES } from "../src/lib/invoice-image";
import { bytesToBase64, fitImageForVision, VISION_IMAGE_TOO_LARGE } from "../src/lib/vision-fit";
import { boundFetch } from "./bound-fetch";

export type OcrPostEnv = {
  GOOGLE_VISION_API_KEY?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

const DATA_URL_RE =
  /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

export function isSpaSameOrigin(request: Request): boolean {
  const expected = requestOrigin(request);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).origin === expected;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}

function cookieMap(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(trimmed.slice(0, eq), decodeURIComponent(trimmed.slice(eq + 1)));
  }
  return cookies;
}

function sessionTokenFromCookie(header: string | null): string | null {
  const cookies = cookieMap(header);
  const direct = cookies.get("sb-access-token");
  if (direct) return direct;
  for (const [name, value] of cookies) {
    if (!/^sb-.*-auth-token$/.test(name) || !value) continue;
    try {
      const parsed = JSON.parse(value) as { access_token?: string };
      if (parsed.access_token) return parsed.access_token;
    } catch {
      if (value.split(".").length === 3) return value;
    }
  }
  return null;
}

export function sessionAccessToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  const bearer = auth?.match(/^Bearer\s+(\S+)/i)?.[1];
  if (bearer) return bearer;
  return sessionTokenFromCookie(request.headers.get("Cookie"));
}

function httpStatusFromVisionCode(code: unknown, fallback: number): number {
  if (typeof code === "number" && code >= 400 && code <= 599) return code;
  if (typeof code === "string") {
    const parsed = Number(code);
    if (parsed >= 400 && parsed <= 599) return parsed;
  }
  return fallback;
}

function visionText(payload: unknown): { text: string; confidence: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const responses = (payload as { responses?: unknown }).responses;
  if (!Array.isArray(responses) || responses.length === 0) return null;
  const first = responses[0];
  if (!first || typeof first !== "object") return null;
  const row = first as {
    error?: { code?: unknown; message?: string };
    fullTextAnnotation?: { text?: string; pages?: { confidence?: number }[] };
    textAnnotations?: { description?: string }[];
  };
  if (row.error) return null;
  const text =
    row.fullTextAnnotation?.text?.trim() ||
    row.textAnnotations?.[0]?.description?.trim() ||
    "";
  if (!text) return null;
  const pageConfidence = row.fullTextAnnotation?.pages?.[0]?.confidence;
  const confidence =
    typeof pageConfidence === "number"
      ? pageConfidence <= 1
        ? pageConfidence * 100
        : pageConfidence
      : 100;
  return { text, confidence };
}

export function parseImageDataUrl(image: unknown):
  | { ok: true; content: string; mime: string }
  | { ok: false; status: number; error: string } {
  if (typeof image !== "string" || !image.trim()) {
    return { ok: false, status: 400, error: "image data URL is required" };
  }
  const match = DATA_URL_RE.exec(image.trim());
  if (!match || match[1].toLowerCase() === "image/svg+xml") {
    return { ok: false, status: 400, error: "image must be a raster data URL" };
  }
  const content = match[2].replace(/\s/g, "");
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((content.length * 3) / 4) - padding;
  if (bytes > MAX_INVOICE_IMAGE_BYTES) {
    return { ok: false, status: 413, error: "Invoice photo must be 8 MB or smaller." };
  }
  return { ok: true, content, mime: match[1].toLowerCase() };
}

function decodeBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function requireSession(
  request: Request,
  env: OcrPostEnv,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  if (!isSpaSameOrigin(request)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const token = sessionAccessToken(request);
  if (!token) {
    return json({ error: "Unauthorized" }, 401);
  }
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const apiKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !apiKey) {
    return json({ error: "Unauthorized" }, 401);
  }
  const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: apiKey,
    },
  });
  if (!response.ok) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

export async function handleOcrPost(
  request: Request,
  env: OcrPostEnv,
  fetchImpl: typeof fetch = boundFetch,
): Promise<Response> {
  const denied = await requireSession(request, env, fetchImpl);
  if (denied) return denied;

  const apiKey = env.GOOGLE_VISION_API_KEY?.trim();
  if (!apiKey) {
    return json({ error: "Vision OCR is not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON" }, 400);
  }

  const parsed = parseImageDataUrl((body as { image?: unknown }).image);
  if (!parsed.ok) {
    return json({ error: parsed.error }, parsed.status);
  }

  let visionContent: string;
  try {
    const fitted = fitImageForVision(decodeBase64(parsed.content), parsed.mime);
    visionContent = bytesToBase64(fitted.bytes);
  } catch {
    return json({ error: VISION_IMAGE_TOO_LARGE }, 413);
  }

  const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
  let visionResponse: Response;
  try {
    visionResponse = await fetchImpl(visionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: visionContent },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["es", "en"] },
          },
        ],
      }),
    });
  } catch {
    return json({ error: "Vision request failed" }, 502);
  }

  let payload: unknown;
  try {
    payload = await visionResponse.json();
  } catch {
    return json({ error: "Vision returned invalid JSON" }, 502);
  }

  const topError =
    payload && typeof payload === "object"
      ? (payload as { error?: { code?: unknown; message?: string } }).error
      : undefined;
  const responseError =
    payload && typeof payload === "object"
      ? (
          payload as {
            responses?: { error?: { code?: unknown; message?: string } }[];
          }
        ).responses?.[0]?.error
      : undefined;
  const visionError = topError ?? responseError;
  if (!visionResponse.ok || visionError) {
    const status = !visionResponse.ok
      ? visionResponse.status
      : httpStatusFromVisionCode(visionError?.code, 502);
    return json(
      { error: visionError?.message?.trim() || "Vision OCR failed" },
      status >= 400 && status <= 599 ? status : 502,
    );
  }

  const extracted = visionText(payload);
  if (!extracted) {
    return json({ error: "Vision returned no text" }, 422);
  }
  return json({ text: extracted.text, confidence: extracted.confidence }, 200);
}
