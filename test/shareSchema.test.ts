import { describe, expect, it } from "vitest";
import { cleanRecord, cleanReport, imageType, MAX_DATA, randomId } from "../src/share/schema.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const good = () => ({ uid: randomId(), install: randomId(), app: "0.1.0", time: "2026-10-26T11:59:00.000Z", kind: "chest", data: { cycle: 3, loot: { "5140": 12 } } });

describe("cleanRecord", () => {
  it("keeps a good record, rebuilt with only the known fields", () => {
    const r = { ...good(), extra: "dropped" };
    expect(cleanRecord(r, NOW)).toEqual({ uid: r.uid, install: r.install, app: r.app, time: r.time, kind: "chest", data: r.data });
  });

  it("rejects bad ids, unknown kinds, odd app versions and times outside 2026..tomorrow", () => {
    expect(cleanRecord({ ...good(), uid: "x" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), install: "ABCDEF0123456789abcdef01" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), kind: "advice" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), app: "<script>" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), time: "2025-12-31T23:59:59Z" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), time: "2026-10-28T12:00:00Z" }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), time: "yesterday" }, NOW)).toBeNull();
  });

  it("takes only plain JSON objects of limited size as data", () => {
    expect(cleanRecord({ ...good(), data: [1, 2] }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), data: null }, NOW)).toBeNull();
    expect(cleanRecord({ ...good(), data: { text: "x".repeat(MAX_DATA) } }, NOW)).toBeNull();
    // undefined / functions don't survive JSON
    expect(cleanRecord({ ...good(), data: { a: 1, b: undefined } }, NOW)?.data).toEqual({ a: 1 });
  });
});

describe("cleanReport", () => {
  const report = () => ({ uid: randomId(), install: randomId(), app: "0.1.0", time: "2026-10-26T11:00:00Z", screen: "voidport", text: "  middle card is Wonder, not Wealth ", read: { cards: [] } });

  it("keeps a good report, text trimmed", () => {
    expect(cleanReport(report(), NOW)?.text).toBe("middle card is Wonder, not Wealth");
    expect(cleanReport({ ...report(), read: null }, NOW)?.read).toBeNull();
  });

  it("rejects odd screens, long text and non-object reads", () => {
    expect(cleanReport({ ...report(), screen: "../etc" }, NOW)).toBeNull();
    expect(cleanReport({ ...report(), text: "x".repeat(2001) }, NOW)).toBeNull();
    expect(cleanReport({ ...report(), read: "cards" }, NOW)).toBeNull();
  });
});

describe("imageType", () => {
  it("goes by the bytes, not the name", () => {
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe("jpeg");
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(imageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(imageType(new Uint8Array(200_001).fill(0xff))).toBeNull();
  });
});
