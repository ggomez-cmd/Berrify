import { decode as decodePng } from "fast-png";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import {
  sniffRasterMime,
  VISION_IMAGE_BYTE_BUDGET,
  VISION_LONG_EDGE,
  visionTargetSize,
} from "./invoice-image";

export const VISION_IMAGE_TOO_LARGE = "Invoice photo is too large for Vision.";

const JPEG_QUALITIES = [80, 65, 50, 35] as const;

type RasterKind = "jpeg" | "png" | "other";

type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type FittedVisionImage = {
  bytes: Uint8Array;
  mime: string;
};

function ensureJpegBuffer(): void {
  const scope = globalThis as { Buffer?: { from: (data: ArrayLike<number>) => Uint8Array } };
  if (typeof scope.Buffer !== "undefined") return;
  scope.Buffer = {
    from(data: ArrayLike<number>) {
      return Uint8Array.from(data);
    },
  };
}

function rasterKind(bytes: Uint8Array, mime: string): RasterKind {
  const sniffed = sniffRasterMime(bytes);
  if (sniffed === "image/jpeg" || mime === "image/jpeg") return "jpeg";
  if (sniffed === "image/png" || mime === "image/png") return "png";
  return "other";
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>>
    0
  );
}

export function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readU16(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;
    if (isSof) {
      const height = readU16(bytes, offset + 5);
      const width = readU16(bytes, offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

export function pngPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (!width || !height) return null;
  return { width, height };
}

function pixelSize(bytes: Uint8Array, kind: RasterKind): { width: number; height: number } | null {
  switch (kind) {
    case "jpeg":
      return jpegPixelSize(bytes);
    case "png":
      return pngPixelSize(bytes);
    case "other":
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function toRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  depth: number,
): Uint8Array | null {
  if (depth !== 8 || data instanceof Uint16Array) return null;
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const pixels = width * height;
  if (channels === 4 && bytes.length >= pixels * 4) return bytes.subarray(0, pixels * 4);
  const rgba = new Uint8Array(pixels * 4);
  if (channels === 3 && bytes.length >= pixels * 3) {
    for (let i = 0, j = 0; i < pixels; i += 1, j += 3) {
      const offset = i * 4;
      rgba[offset] = bytes[j];
      rgba[offset + 1] = bytes[j + 1];
      rgba[offset + 2] = bytes[j + 2];
      rgba[offset + 3] = 255;
    }
    return rgba;
  }
  if (channels === 1 && bytes.length >= pixels) {
    for (let i = 0; i < pixels; i += 1) {
      const offset = i * 4;
      rgba[offset] = bytes[i];
      rgba[offset + 1] = bytes[i];
      rgba[offset + 2] = bytes[i];
      rgba[offset + 3] = 255;
    }
    return rgba;
  }
  if (channels === 2 && bytes.length >= pixels * 2) {
    for (let i = 0, j = 0; i < pixels; i += 1, j += 2) {
      const offset = i * 4;
      rgba[offset] = bytes[j];
      rgba[offset + 1] = bytes[j];
      rgba[offset + 2] = bytes[j];
      rgba[offset + 3] = bytes[j + 1];
    }
    return rgba;
  }
  return null;
}

function decodeRgba(bytes: Uint8Array, kind: RasterKind): RgbaImage | null {
  switch (kind) {
    case "jpeg": {
      const decoded = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: 24,
        maxMemoryUsageInMB: 96,
      });
      return { width: decoded.width, height: decoded.height, data: decoded.data };
    }
    case "png": {
      const decoded = decodePng(bytes);
      const data = toRgba(decoded.data, decoded.width, decoded.height, decoded.channels, decoded.depth);
      if (!data) return null;
      return { width: decoded.width, height: decoded.height, data };
    }
    case "other":
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function scaleDownRgba(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  if (sw === dw && sh === dh) return src;
  const dst = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * sw + sx) * 4;
          r += src[index];
          g += src[index + 1];
          b += src[index + 2];
          a += src[index + 3];
          count += 1;
        }
      }
      const offset = (y * dw + x) * 4;
      dst[offset] = Math.round(r / count);
      dst[offset + 1] = Math.round(g / count);
      dst[offset + 2] = Math.round(b / count);
      dst[offset + 3] = Math.round(a / count);
    }
  }
  return dst;
}

function jpegBytes(data: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  ensureJpegBuffer();
  const encoded = encodeJpeg({ data, width, height }, quality);
  return new Uint8Array(encoded.data);
}

function encodeFitted(image: RgbaImage): Uint8Array {
  let sourceW = image.width;
  let sourceH = image.height;
  let pixels = image.data;
  let longEdge = Math.min(VISION_LONG_EDGE, Math.max(sourceW, sourceH));
  let best: Uint8Array | null = null;
  for (let shrink = 0; shrink < 5; shrink += 1) {
    const size = visionTargetSize(sourceW, sourceH, longEdge);
    const scaled = scaleDownRgba(pixels, sourceW, sourceH, size.width, size.height);
    for (const quality of JPEG_QUALITIES) {
      const jpeg = jpegBytes(scaled, size.width, size.height, quality);
      best = jpeg;
      if (jpeg.byteLength <= VISION_IMAGE_BYTE_BUDGET) return jpeg;
    }
    if (longEdge <= 1024) break;
    sourceW = size.width;
    sourceH = size.height;
    pixels = scaled;
    longEdge = Math.max(1024, Math.round(longEdge * 0.75));
  }
  if (!best || best.byteLength > VISION_IMAGE_BYTE_BUDGET) {
    throw new Error(VISION_IMAGE_TOO_LARGE);
  }
  return best;
}

/**
 * Bytes actually posted to images:annotate.
 * images:annotate answers 429 RESOURCE_EXHAUSTED when the JSON body exceeds 10 MB,
 * so an over-budget upload is resized here even if the browser sent the original file.
 */
export function fitImageForVision(bytes: Uint8Array, mime: string): FittedVisionImage {
  const normalized = mime.toLowerCase();
  const kind = rasterKind(bytes, normalized);
  const size = pixelSize(bytes, kind);
  const longEdge = size ? Math.max(size.width, size.height) : 0;
  const withinBudget = bytes.byteLength <= VISION_IMAGE_BYTE_BUDGET;
  const withinEdge = size ? longEdge <= VISION_LONG_EDGE : true;
  if (withinBudget && withinEdge) {
    return { bytes, mime: normalized };
  }
  try {
    const rgba = decodeRgba(bytes, kind);
    if (!rgba) throw new Error(VISION_IMAGE_TOO_LARGE);
    return { bytes: encodeFitted(rgba), mime: "image/jpeg" };
  } catch (error) {
    if (withinBudget) return { bytes, mime: normalized };
    if (error instanceof Error && error.message === VISION_IMAGE_TOO_LARGE) throw error;
    throw new Error(VISION_IMAGE_TOO_LARGE);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
