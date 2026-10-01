import {
  dataUrlByteLength,
  MAX_INVOICE_IMAGE_BYTES,
  VISION_IMAGE_BYTE_BUDGET,
  VISION_LONG_EDGE,
  visionTargetSize,
} from "./invoice-image";

const VISION_JPEG_QUALITIES = [0.85, 0.72, 0.6, 0.48] as const;

type Drawable = {
  width: number;
  height: number;
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
};

function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/i.exec(header)?.[1] ?? "application/octet-stream";
  const payload = dataUrl.slice(comma + 1).replace(/\s/g, "");
  if (!/;base64/i.test(header)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load invoice image"));
    img.src = src;
  });
}

function drawableFromImage(src: string, close: () => void = () => {}): Promise<Drawable> {
  return loadHtmlImage(src).then((img) => ({
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    draw: (ctx, width, height) => {
      ctx.drawImage(img, 0, 0, width, height);
    },
    close,
  }));
}

async function loadDrawable(image: string): Promise<Drawable> {
  // Chrome rejects data URLs longer than about 2MB as image sources. A PC photo
  // then never decodes, and the previous fail-open posted that original file.
  let blob = dataUrlToBlob(image);
  if (!blob && !image.startsWith("data:")) {
    const response = await fetch(image);
    if (!response.ok) throw new Error("Could not load invoice image");
    blob = await response.blob();
  }
  if (!blob) return drawableFromImage(image);
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, width, height) => {
          ctx.drawImage(bitmap, 0, 0, width, height);
        },
        close: () => bitmap.close(),
      };
    } catch {
      // Blob URL + Image still decodes the same bytes when bitmap decode fails.
    }
  }
  if (typeof URL.createObjectURL !== "function") return drawableFromImage(image);
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await drawableFromImage(objectUrl, () => URL.revokeObjectURL(objectUrl));
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function renderJpeg(
  drawable: Drawable,
  width: number,
  height: number,
  quality: number,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawable.draw(ctx, width, height);
  const url = canvas.toDataURL("image/jpeg", quality);
  return url.startsWith("data:image/jpeg") ? url : null;
}

function encodeFittedJpeg(drawable: Drawable): string | null {
  const sourceLong = Math.max(drawable.width, drawable.height);
  let longEdge = Math.min(VISION_LONG_EDGE, sourceLong || VISION_LONG_EDGE);
  let best: string | null = null;
  for (let shrink = 0; shrink < 5; shrink += 1) {
    const size = visionTargetSize(drawable.width, drawable.height, longEdge);
    for (const quality of VISION_JPEG_QUALITIES) {
      const jpeg = renderJpeg(drawable, size.width, size.height, quality);
      if (!jpeg) return best;
      best = jpeg;
      if (dataUrlByteLength(jpeg) <= VISION_IMAGE_BYTE_BUDGET) return jpeg;
    }
    if (longEdge <= 1024) break;
    longEdge = Math.max(1024, Math.round(longEdge * 0.75));
  }
  return best;
}

/** JPEG small enough for Cloud Vision: long edge capped, file under 8 MB and under the 10 MB JSON cap. */
export async function downscaleForVision(image: string): Promise<string> {
  const trimmed = image.trim();
  if (!trimmed || typeof document === "undefined") return trimmed;
  if (!document.createElement("canvas").getContext("2d")) return trimmed;
  let drawable: Drawable | null = null;
  try {
    drawable = await loadDrawable(trimmed);
    const { width, height } = drawable;
    if (!width || !height) return trimmed;
    const fitted = visionTargetSize(width, height);
    const withinEdge = fitted.width === Math.round(width) && fitted.height === Math.round(height);
    const jpeg = trimmed.startsWith("data:image/jpeg");
    if (withinEdge && jpeg && dataUrlByteLength(trimmed) <= VISION_IMAGE_BYTE_BUDGET) {
      return trimmed;
    }
    const encoded = encodeFittedJpeg(drawable);
    if (!encoded) return trimmed;
    if (
      dataUrlByteLength(encoded) > MAX_INVOICE_IMAGE_BYTES &&
      dataUrlByteLength(encoded) >= dataUrlByteLength(trimmed)
    ) {
      return trimmed;
    }
    return encoded;
  } catch {
    return trimmed;
  } finally {
    drawable?.close();
  }
}
