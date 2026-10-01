import {
  dataUrlByteLength,
  MAX_INVOICE_IMAGE_BYTES,
  VISION_IMAGE_BYTE_BUDGET,
  VISION_LONG_EDGE,
  visionTargetSize,
} from "./invoice-image";

const VISION_JPEG_QUALITIES = [0.85, 0.72, 0.6, 0.48] as const;

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load invoice image"));
    img.src = src;
  });
}

function renderJpeg(
  img: HTMLImageElement,
  width: number,
  height: number,
  quality: number,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  const url = canvas.toDataURL("image/jpeg", quality);
  return url.startsWith("data:image/jpeg") ? url : null;
}

function encodeFittedJpeg(img: HTMLImageElement): string | null {
  const sourceLong = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
  let longEdge = Math.min(VISION_LONG_EDGE, sourceLong || VISION_LONG_EDGE);
  let best: string | null = null;
  for (let shrink = 0; shrink < 5; shrink += 1) {
    const size = visionTargetSize(
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      longEdge,
    );
    for (const quality of VISION_JPEG_QUALITIES) {
      const jpeg = renderJpeg(img, size.width, size.height, quality);
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
  try {
    const img = await loadHtmlImage(trimmed);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return trimmed;
    const fitted = visionTargetSize(width, height);
    const withinEdge = fitted.width === Math.round(width) && fitted.height === Math.round(height);
    const jpeg = trimmed.startsWith("data:image/jpeg");
    if (withinEdge && jpeg && dataUrlByteLength(trimmed) <= VISION_IMAGE_BYTE_BUDGET) {
      return trimmed;
    }
    const encoded = encodeFittedJpeg(img);
    if (!encoded || dataUrlByteLength(encoded) > MAX_INVOICE_IMAGE_BYTES) return trimmed;
    return encoded;
  } catch {
    return trimmed;
  }
}
