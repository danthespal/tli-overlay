// What the overlay shares with the collector (worker/), and the checks both sides run on it.
// No Node or Electron imports: the Worker bundles this file too.
//
// A record is one line the overlay already writes to its dataset (a pick, a chest, a read...),
// wrapped with a random record id, the player's random install id, the app version and the time.
// A report is one "that was wrong" from the player: their words, what was read, and the frame.

export const KINDS = ["session", "capture", "cards", "flames", "skipped", "picked", "flameChosen", "chest", "bossRun", "salvage", "goal"] as const;
export type Kind = (typeof KINDS)[number];

export interface ShareRecord {
  uid: string;
  install: string;
  app: string;
  time: string;
  kind: Kind;
  data: Record<string, unknown>;
}

export interface ShareReport {
  uid: string;
  install: string;
  app: string;
  time: string;
  /** Which screen the frame is of (voidport, voidbeacon). */
  screen: string;
  text: string;
  /** What the overlay read from the frame. */
  read: Record<string, unknown> | null;
}

export const MAX_RECORDS = 50; // per upload
export const MAX_DATA = 16_000; // characters of one record's data as JSON
export const MAX_TEXT = 2000;
export const MAX_IMAGE = 200_000; // bytes

const ID = /^[0-9a-f]{24}$/;
const APP = /^[\w.-]{1,24}$/;
const SCREEN = /^[a-z]{1,20}$/;
const EARLIEST = Date.parse("2026-01-01T00:00:00Z");

/** 24 hex characters from 12 random bytes. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** A time no earlier than 2026 and no later than a day ahead of `now` (clocks are off sometimes). */
function cleanTime(x: unknown, now: number): string | null {
  if (typeof x !== "string" || x.length > 30) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) && t >= EARLIEST && t <= now + 86_400_000 ? new Date(t).toISOString() : null;
}

/** Plain JSON data of at most MAX_DATA characters (re-serialised, so nothing but JSON survives). */
function cleanData(x: unknown): Record<string, unknown> | null {
  if (!isPlainObject(x)) return null;
  const json = JSON.stringify(x);
  return json.length <= MAX_DATA ? (JSON.parse(json) as Record<string, unknown>) : null;
}

/** The record rebuilt from the fields it should have, or null when anything is off. */
export function cleanRecord(x: unknown, now = Date.now()): ShareRecord | null {
  if (!isPlainObject(x)) return null;
  const { uid, install, app, kind } = x;
  if (typeof uid !== "string" || !ID.test(uid) || typeof install !== "string" || !ID.test(install)) return null;
  if (typeof app !== "string" || !APP.test(app) || !KINDS.includes(kind as Kind)) return null;
  const time = cleanTime(x.time, now);
  const data = cleanData(x.data);
  return time && data ? { uid, install, app, time, kind: kind as Kind, data } : null;
}

export function cleanReport(x: unknown, now = Date.now()): ShareReport | null {
  if (!isPlainObject(x)) return null;
  const { uid, install, app, screen, text } = x;
  if (typeof uid !== "string" || !ID.test(uid) || typeof install !== "string" || !ID.test(install)) return null;
  if (typeof app !== "string" || !APP.test(app) || typeof screen !== "string" || !SCREEN.test(screen)) return null;
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  const time = cleanTime(x.time, now);
  const read = x.read === null || x.read === undefined ? null : cleanData(x.read);
  if (!time || (x.read != null && !read)) return null;
  return { uid, install, app, time, screen, text: text.trim(), read };
}

/** The image type from its first bytes (not from what the sender says), or null. */
export function imageType(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length > MAX_IMAGE || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}
