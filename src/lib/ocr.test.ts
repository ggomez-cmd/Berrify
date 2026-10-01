import { describe, expect, it, vi } from "vitest";
import { getOcrEngine, ocrEngineNote, ocrImage, setOcrEngine, type OcrResult } from "./ocr";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "user-token" } } }),
    },
  },
}));

const tesseract: OcrResult = {
  text: "TESSA FACTURA 1.00",
  confidence: 70,
  rotation: 90,
  engine: "tesseract",
};

describe("ocrImage", () => {
  it("returns Vision text when /api/ocr succeeds", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("/api/ocr");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer user-token");
      return Response.json({ text: "VISION FACTURA", confidence: 88 });
    };
    const result = await ocrImage("data:image/jpeg;base64,abc", { fetchImpl, fallback });
    expect(result).toEqual({
      text: "VISION FACTURA",
      confidence: 88,
      rotation: 0,
      engine: "vision",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to Tesseract when Vision returns 503", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: "Vision OCR is not configured" }, { status: 503 });
    const result = await ocrImage("data:image/jpeg;base64,abc", { fetchImpl, fallback });
    expect(result).toEqual(tesseract);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back to Tesseract when Vision fetch throws", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const result = await ocrImage("data:image/jpeg;base64,abc", { fetchImpl, fallback });
    expect(result.engine).toBe("tesseract");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("sends a downscaled JPEG to Vision for a large photo", async () => {
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
    const jpeg = `data:image/jpeg;base64,${"BB".repeat(24)}`;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage() {},
    } as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(jpeg);
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("/api/ocr");
      const body = JSON.parse(String(init?.body ?? "{}")) as { image?: string };
      expect(body.image).toBe(jpeg);
      return Response.json({ text: "VISION FROM SMALL JPEG", confidence: 90 });
    };
    try {
      const result = await ocrImage("data:image/jpeg;base64,/9j/PC-PHOTO", {
        engine: "vision",
        fetchImpl,
        fallback,
      });
      expect(result).toEqual({
        text: "VISION FROM SMALL JPEG",
        confidence: 90,
        rotation: 0,
        engine: "vision",
      });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = RealImage;
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });

  it("Vision-only does not call Tesseract when /api/ocr succeeds", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () => Response.json({ text: "VISION ONLY", confidence: 91 });
    const result = await ocrImage("data:image/jpeg;base64,abc", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result.engine).toBe("vision");
    expect(result.text).toBe("VISION ONLY");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("explicit Vision falls back to Tesseract when /api/ocr fails", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: "Vision OCR is not configured" }, { status: 503 });
    const result = await ocrImage("data:image/jpeg;base64,abc", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result).toEqual({ ...tesseract, warning: "Vision OCR is not configured" });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("explicit Vision falls back on quota and keeps the Google message", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () =>
      Response.json(
        { error: "Resource has been exhausted (e.g. check quota)." },
        { status: 429 },
      );
    const result = await ocrImage("data:image/jpeg;base64,abc", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result.engine).toBe("tesseract");
    expect(result.text).toBe(tesseract.text);
    expect(result.warning).toBe("Resource has been exhausted (e.g. check quota).");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("explicit Vision falls back when /api/ocr is Unauthorized", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 });
    const result = await ocrImage("data:image/jpeg;base64,abc", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result).toMatchObject({ engine: "tesseract", text: tesseract.text, warning: "Unauthorized" });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("Tesseract-only does not call /api/ocr", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl = vi.fn(async () => Response.json({ text: "VISION", confidence: 99 }));
    const result = await ocrImage("data:image/jpeg;base64,abc", {
      engine: "tesseract",
      fetchImpl,
      fallback,
    });
    expect(result).toEqual(tesseract);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("converts a storage URL to a raster data URL before calling Vision", async () => {
    const fallback = vi.fn(async () => tesseract);
    const bytes = Uint8Array.from(atob("/9j/4AAQ"), (c) => c.charCodeAt(0));
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://example.supabase.co/storage/v1/object/public/bills/a.jpg") {
        return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
      }
      expect(url).toBe("/api/ocr");
      const body = JSON.parse(String(init?.body ?? "{}")) as { image?: string };
      expect(body.image?.startsWith("data:image/jpeg;base64,")).toBe(true);
      return Response.json({ text: "VISION FROM URL", confidence: 80 });
    };
    const result = await ocrImage("https://example.supabase.co/storage/v1/object/public/bills/a.jpg", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result.text).toBe("VISION FROM URL");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rewrites octet-stream JPEG data URLs before calling Vision", async () => {
    const fallback = vi.fn(async () => tesseract);
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("/api/ocr");
      const body = JSON.parse(String(init?.body ?? "{}")) as { image?: string };
      expect(body.image).toBe("data:image/jpeg;base64,/9j/4AAQ");
      return Response.json({ text: "VISION FROM OCTET", confidence: 80 });
    };
    const result = await ocrImage("data:application/octet-stream;base64,/9j/4AAQ", {
      engine: "vision",
      fetchImpl,
      fallback,
    });
    expect(result.text).toBe("VISION FROM OCTET");
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("getOcrEngine / setOcrEngine", () => {
  it("defaults to vision and persists the selected engine", () => {
    localStorage.removeItem("berrify.ocrEngine");
    expect(getOcrEngine()).toBe("vision");
    setOcrEngine("tesseract");
    expect(localStorage.getItem("berrify.ocrEngine")).toBe("tesseract");
    expect(getOcrEngine()).toBe("tesseract");
    setOcrEngine("vision");
    expect(getOcrEngine()).toBe("vision");
  });
});

describe("ocrEngineNote", () => {
  it("names Vision vs Tesseract rotation", () => {
    expect(
      ocrEngineNote({ text: "a", confidence: 1, rotation: 0, engine: "vision" }),
    ).toBe("Vision OCR");
    expect(
      ocrEngineNote({ text: "a", confidence: 1, rotation: 90, engine: "tesseract" }),
    ).toBe("Tesseract OCR rotation 90°");
  });
});

