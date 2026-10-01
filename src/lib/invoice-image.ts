export const MAX_INVOICE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Longest side sent to Cloud Vision. Phone photos are larger; DOCUMENT_TEXT_DETECTION is aimed around 1024×768. */
export const VISION_LONG_EDGE = 2048;

/**
 * images:annotate rejects JSON bodies over 10 MB. Base64 is about 4/3 of the
 * file, so the JPEG must stay under both that request cap and the 8 MB photo limit.
 */
const VISION_JSON_LIMIT_BYTES = 10 * 1024 * 1024;
const VISION_REQUEST_OVERHEAD_BYTES = 2 * 1024;
const VISION_JSON_BASE64_GROUPS = Math.floor(
  (VISION_JSON_LIMIT_BYTES - VISION_REQUEST_OVERHEAD_BYTES - 1) / 4,
);
export const VISION_IMAGE_BYTE_BUDGET = Math.min(
  MAX_INVOICE_IMAGE_BYTES,
  VISION_JSON_BASE64_GROUPS * 3,
);

const RASTER_DATA_URL_RE =
  /^data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/;
const ANY_BASE64_DATA_URL_RE =
  /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/;

export function assertInvoiceImage(file: File): void {
  if (file.size > MAX_INVOICE_IMAGE_BYTES) {
    throw new Error("Invoice photo must be 8 MB or smaller.");
  }
  const mime = file.type.toLowerCase();
  if (mime === "image/svg+xml" || (mime && !mime.startsWith("image/"))) {
    throw new Error("Invoice must be a raster image file.");
  }
}

export function isRasterDataUrl(image: string): boolean {
  const match = RASTER_DATA_URL_RE.exec(image.trim());
  return Boolean(match && match[1].toLowerCase() !== "image/svg+xml");
}

export function sniffRasterMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function rasterMimeForPhoto(bytes: Uint8Array, declaredMime?: string | null): string {
  const mime = (declaredMime || "").split(";")[0].trim().toLowerCase();
  if (mime === "image/svg+xml") {
    throw new Error("Invoice must be a raster image file.");
  }
  if (mime.startsWith("image/")) return mime;
  const sniffed = sniffRasterMime(bytes);
  if (sniffed) return sniffed;
  throw new Error("image must be a raster data URL");
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(content: string): Uint8Array {
  const raw = content.replace(/\s/g, "");
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function visionTargetSize(
  width: number,
  height: number,
  longEdge = VISION_LONG_EDGE,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(width, height);
  if (longest <= longEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = longEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1).replace(/\s/g, "");
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return payload.length;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Turn a stored invoice photo (data URL, https storage URL, or blob URL) into a raster data URL. */
export async function toRasterDataUrl(
  image: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const trimmed = image.trim();
  if (!trimmed) {
    throw new Error("Invoice photo is missing.");
  }
  if (isRasterDataUrl(trimmed)) {
    return trimmed;
  }

  const dataUrl = ANY_BASE64_DATA_URL_RE.exec(trimmed);
  if (dataUrl) {
    const bytes = decodeBase64(dataUrl[2]);
    if (bytes.byteLength > MAX_INVOICE_IMAGE_BYTES) {
      throw new Error("Invoice photo must be 8 MB or smaller.");
    }
    const mime = rasterMimeForPhoto(bytes, dataUrl[1]);
    return `data:${mime};base64,${dataUrl[2].replace(/\s/g, "")}`;
  }

  if (!/^(https?:|blob:)/i.test(trimmed)) {
    throw new Error("image must be a raster data URL");
  }

  const response = await fetchImpl(trimmed);
  if (!response.ok) {
    throw new Error("Could not load invoice photo");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_INVOICE_IMAGE_BYTES) {
    throw new Error("Invoice photo must be 8 MB or smaller.");
  }
  const bytes = new Uint8Array(buffer);
  const mime = rasterMimeForPhoto(bytes, response.headers.get("content-type"));
  const raster = `data:${mime};base64,${bytesToBase64(bytes)}`;
  if (!isRasterDataUrl(raster)) {
    throw new Error("Invoice must be a raster image file.");
  }
  return raster;
}
