import { describe, expect, it, vi } from "vitest";
import {
  assertInvoiceImage,
  dataUrlByteLength,
  isRasterDataUrl,
  MAX_INVOICE_IMAGE_BYTES,
  toRasterDataUrl,
  VISION_IMAGE_BYTE_BUDGET,
  VISION_LONG_EDGE,
  visionTargetSize,
} from "./invoice-image";
import { downscaleForVision } from "./vision-jpeg";

function file(name: string, type: string, size = 16): File {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

describe("assertInvoiceImage", () => {
  it("accepts jpeg photos", () => {
    expect(() => assertInvoiceImage(file("bill.jpg", "image/jpeg"))).not.toThrow();
  });

  it("rejects svg and non-images", () => {
    expect(() => assertInvoiceImage(file("bill.svg", "image/svg+xml"))).toThrow(/raster image/);
    expect(() => assertInvoiceImage(file("bill.pdf", "application/pdf"))).toThrow(/raster image/);
  });

  it("rejects oversized files", () => {
    expect(() =>
      assertInvoiceImage(file("huge.jpg", "image/jpeg", MAX_INVOICE_IMAGE_BYTES + 1)),
    ).toThrow(/8 MB/);
  });
});

describe("visionTargetSize", () => {
  it("caps the long edge and keeps the aspect ratio", () => {
    expect(visionTargetSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(visionTargetSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(visionTargetSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(Math.max(visionTargetSize(8000, 6000).width, visionTargetSize(8000, 6000).height)).toBe(
      VISION_LONG_EDGE,
    );
  });

  it("stays under the 8 MB photo limit and Vision's 10 MB JSON body", () => {
    expect(VISION_IMAGE_BYTE_BUDGET).toBeLessThanOrEqual(MAX_INVOICE_IMAGE_BYTES);
    const base64 = Math.ceil(VISION_IMAGE_BYTE_BUDGET / 3) * 4;
    expect(base64 + 2 * 1024).toBeLessThan(10 * 1024 * 1024);
  });
});

describe("downscaleForVision", () => {
  const smallJpeg = "data:image/jpeg;base64,/9j/4AAQ";

  it("leaves an unreadable image unchanged", async () => {
    await expect(downscaleForVision(smallJpeg)).resolves.toBe(smallJpeg);
  });

  it("turns a wide photo into a JPEG whose long edge is capped", async () => {
    const RealImage = globalThis.Image;
    class WidePhoto {
      naturalWidth = 4032;
      naturalHeight = 3024;
      width = 4032;
      height = 3024;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        void Promise.resolve().then(() => this.onload?.());
      }
    }
    globalThis.Image = WidePhoto as unknown as typeof Image;
    const jpeg = `data:image/jpeg;base64,${"AA".repeat(32)}`;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage() {},
    } as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      expect(this.width).toBe(2048);
      expect(this.height).toBe(1536);
      expect(Math.max(this.width, this.height)).toBeLessThanOrEqual(VISION_LONG_EDGE);
      return jpeg;
    });
    try {
      const source = "data:image/jpeg;base64,/9j/HUGE";
      await expect(downscaleForVision(source)).resolves.toBe(jpeg);
      expect(dataUrlByteLength(jpeg)).toBeLessThanOrEqual(VISION_IMAGE_BYTE_BUDGET);
      expect(dataUrlByteLength(jpeg)).toBeLessThanOrEqual(MAX_INVOICE_IMAGE_BYTES);
    } finally {
      globalThis.Image = RealImage;
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });
});

describe("isRasterDataUrl / toRasterDataUrl", () => {
  const jpegDataUrl = "data:image/jpeg;base64,/9j/4AAQ";

  it("accepts raster data URLs and rejects svg data URLs", () => {
    expect(isRasterDataUrl(jpegDataUrl)).toBe(true);
    expect(isRasterDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isRasterDataUrl("https://example.supabase.co/storage/v1/object/public/bills/a.jpg")).toBe(
      false,
    );
  });

  it("rewrites octet-stream JPEG data URLs into raster image data URLs", async () => {
    const stored = "data:application/octet-stream;base64,/9j/4AAQ";
    await expect(toRasterDataUrl(stored)).resolves.toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("returns an existing raster data URL unchanged", async () => {
    await expect(toRasterDataUrl(jpegDataUrl)).resolves.toBe(jpegDataUrl);
  });

  it("fetches https and blob storage URLs into a raster data URL", async () => {
    const bytes = Uint8Array.from(atob("/9j/4AAQ"), (c) => c.charCodeAt(0));
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe("https://example.supabase.co/storage/v1/object/public/bills/a.jpg");
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
    };
    const result = await toRasterDataUrl(
      "https://example.supabase.co/storage/v1/object/public/bills/a.jpg",
      fetchImpl,
    );
    expect(result.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(isRasterDataUrl(result)).toBe(true);
  });

  it("rejects svg downloads and empty input", async () => {
    await expect(toRasterDataUrl("")).rejects.toThrow(/missing/);
    const fetchImpl: typeof fetch = async () =>
      new Response("<svg></svg>", { headers: { "Content-Type": "image/svg+xml" } });
    await expect(toRasterDataUrl("https://cdn.example/bill.svg", fetchImpl)).rejects.toThrow(
      /raster image/,
    );
  });
});
