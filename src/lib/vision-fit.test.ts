import { encode as encodePng } from "fast-png";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { VISION_IMAGE_BYTE_BUDGET, VISION_LONG_EDGE } from "./invoice-image";
import { bytesToBase64, fitImageForVision, jpegPixelSize, VISION_IMAGE_TOO_LARGE } from "./vision-fit";

function solidJpeg(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 210;
    data[i + 1] = 180;
    data[i + 2] = 140;
    data[i + 3] = 255;
  }
  return new Uint8Array(encodeJpeg({ data, width, height }, 75).data);
}

describe("fitImageForVision", () => {
  it("leaves a small JPEG unchanged", () => {
    const bytes = solidJpeg(80, 60);
    const fitted = fitImageForVision(bytes, "image/jpeg");
    expect(fitted.mime).toBe("image/jpeg");
    expect(fitted.bytes).toBe(bytes);
    expect(jpegPixelSize(bytes)).toEqual({ width: 80, height: 60 });
  });

  it("caps a wide JPEG before it would be posted to Vision", () => {
    const bytes = solidJpeg(2400, 16);
    const fitted = fitImageForVision(bytes, "image/jpeg");
    const size = jpegPixelSize(fitted.bytes);
    expect(fitted.mime).toBe("image/jpeg");
    expect(fitted.bytes).not.toBe(bytes);
    expect(size).not.toBeNull();
    expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBeLessThanOrEqual(VISION_LONG_EDGE);
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(VISION_IMAGE_BYTE_BUDGET);
    const decoded = decodeJpeg(fitted.bytes, { useTArray: true });
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(VISION_LONG_EDGE);
  });

  it("turns a wide PNG into a JPEG under the same cap", () => {
    const width = 3000;
    const height = 8;
    const png = encodePng({
      width,
      height,
      data: new Uint8Array(width * height * 4).fill(255),
      channels: 4,
      depth: 8,
    });
    const fitted = fitImageForVision(png, "image/png");
    const size = jpegPixelSize(fitted.bytes);
    expect(fitted.mime).toBe("image/jpeg");
    expect(size).not.toBeNull();
    expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBeLessThanOrEqual(VISION_LONG_EDGE);
  });

  it("refuses an undecodable image past the Vision JSON budget", () => {
    const bytes = new Uint8Array(VISION_IMAGE_BYTE_BUDGET + 1);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    expect(() => fitImageForVision(bytes, "image/jpeg")).toThrow(VISION_IMAGE_TOO_LARGE);
    expect(bytesToBase64(Uint8Array.from([0xff, 0xd8]))).toBe("/9g=");
  });
});
