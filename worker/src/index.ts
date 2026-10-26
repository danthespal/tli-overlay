// The collector: a Cloudflare Worker with a D1 database (schema.sql).
//   POST /v1/records   up to MAX_RECORDS shared records from the overlay
//   POST /v1/reports   one "that was wrong" report with its frame
//   POST /v1/forget    deletes everything an install shared (the player's "delete my data")
//   GET  /v1/export    records after ?after=ID, for the repo's collect workflow (export token)
//   GET  /v1/reports   reports after ?after=ID, for `npm run reports` (export token)
// No accounts, no addresses stored: the limits are kept against a salted hash of the address
// that changes daily.

import { cleanRecord, cleanReport, imageType, MAX_IMAGE, MAX_RECORDS } from "../../src/share/schema.ts";

export interface Env {
  DB: D1Database;
  EXPORT_TOKEN: string;
  IP_SALT: string;
}

const PER_MINUTE = 60; // uploads per address
const RECORDS_PER_DAY = 5000;
const REPORTS_PER_DAY = 20;
const MAX_BODY = 1_000_000;
const EXPORT_PAGE = 500;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counts this upload against the sender's limits; false when one is used up. */
async function allow(env: Env, req: Request, records: number, reports: number): Promise<boolean> {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60_000);
  const key = await sha256(`${env.IP_SALT}|${day}|${req.headers.get("CF-Connecting-IP") ?? "?"}`);
  const row = await env.DB.prepare("SELECT minute, minute_count, records, reports FROM limits WHERE key = ?")
    .bind(key)
    .first<{ minute: number; minute_count: number; records: number; reports: number }>();
  const used = row ?? { minute, minute_count: 0, records: 0, reports: 0 };
  const perMinute = used.minute === minute ? used.minute_count + 1 : 1;
  if (perMinute > PER_MINUTE || used.records + records > RECORDS_PER_DAY || used.reports + reports > REPORTS_PER_DAY) return false;
  // A sender's first upload of the day: yesterday's counters (other keys) are dead, drop them so
  // the table holds one day, not one row per sender per day forever.
  if (!row) await env.DB.prepare("DELETE FROM limits WHERE day < ?").bind(day).run();
  await env.DB.prepare(
    "INSERT INTO limits (key, day, minute, minute_count, records, reports) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET minute = excluded.minute, minute_count = excluded.minute_count, records = excluded.records, reports = excluded.reports",
  )
    .bind(key, day, minute, perMinute, used.records + records, used.reports + reports)
    .run();
  return true;
}

async function body(req: Request): Promise<unknown> {
  // Refused before reading, when the sender says it is too large (the text check covers the rest).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new Error("too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("too large");
  return JSON.parse(text);
}

function authorized(req: Request, env: Env): boolean {
  const given = req.headers.get("Authorization") ?? "";
  const want = `Bearer ${env.EXPORT_TOKEN}`;
  if (!env.EXPORT_TOKEN || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: ArrayBuffer | null): string | null {
  if (!bytes) return null;
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function postRecords(req: Request, env: Env): Promise<Response> {
  const input = (await body(req)) as { records?: unknown };
  if (!Array.isArray(input.records) || input.records.length === 0 || input.records.length > MAX_RECORDS) return json({ error: "records: 1 to 50" }, 400);
  if (!(await allow(env, req, input.records.length, 0))) return json({ error: "limit reached, try later" }, 429);
  const received = new Date().toISOString().slice(0, 10);
  const clean = input.records.map((r) => cleanRecord(r)).filter((r) => r !== null);
  if (clean.length) {
    await env.DB.batch(
      clean.map((r) =>
        env.DB.prepare("INSERT OR IGNORE INTO records (uid, install, app, time, kind, data, received) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
          r.uid, r.install, r.app, r.time, r.kind, JSON.stringify(r.data), received,
        ),
      ),
    );
  }
  // Rejected records aren't retried by the overlay: they would be rejected again.
  return json({ accepted: clean.length, rejected: input.records.length - clean.length });
}

async function postReport(req: Request, env: Env): Promise<Response> {
  const input = (await body(req)) as { report?: unknown; image?: unknown };
  const report = cleanReport(input.report);
  if (!report) return json({ error: "bad report" }, 400);
  let image: Uint8Array | null = null;
  if (typeof input.image === "string") {
    if (input.image.length > (MAX_IMAGE * 4) / 3 + 4) return json({ error: "image too large" }, 400);
    image = base64ToBytes(input.image);
  }
  const type = image ? imageType(image) : null;
  if (image && !type) return json({ error: "image must be a JPEG or PNG under 200 KB" }, 400);
  if (!(await allow(env, req, 0, 1))) return json({ error: "limit reached, try tomorrow" }, 429);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO reports (uid, install, app, time, screen, text, read, image, image_type, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(report.uid, report.install, report.app, report.time, report.screen, report.text, report.read ? JSON.stringify(report.read) : null, image, type, new Date().toISOString().slice(0, 10))
    .run();
  return json({ ok: true });
}

async function forget(req: Request, env: Env): Promise<Response> {
  const input = (await body(req)) as { install?: unknown };
  if (typeof input.install !== "string" || !/^[0-9a-f]{24}$/.test(input.install)) return json({ error: "bad install id" }, 400);
  if (!(await allow(env, req, 0, 0))) return json({ error: "limit reached, try later" }, 429);
  const [a, b] = await env.DB.batch([
    env.DB.prepare("DELETE FROM records WHERE install = ?").bind(input.install),
    env.DB.prepare("DELETE FROM reports WHERE install = ?").bind(input.install),
  ]);
  return json({ deleted: (a?.meta.changes ?? 0) + (b?.meta.changes ?? 0) });
}

async function exportRecords(url: URL, env: Env): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const limit = Math.min(EXPORT_PAGE, Number(url.searchParams.get("limit") ?? EXPORT_PAGE) || EXPORT_PAGE);
  const { results } = await env.DB.prepare("SELECT id, uid, install, app, time, kind, data, received FROM records WHERE id > ? ORDER BY id LIMIT ?")
    .bind(after, limit)
    .all<{ id: number; data: string }>();
  const rows = results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  return json({ rows, last: rows.at(-1)?.id ?? after });
}

async function exportReports(url: URL, env: Env): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  // Frames are up to 200 KB each: small pages.
  const { results } = await env.DB.prepare("SELECT id, uid, install, app, time, screen, text, read, image, image_type, received FROM reports WHERE id > ? ORDER BY id LIMIT 20")
    .bind(after)
    .all<{ id: number; read: string | null; image: ArrayBuffer | null }>();
  const rows = results.map((r) => ({ ...r, read: r.read ? JSON.parse(r.read) : null, image: bytesToBase64(r.image) }));
  return json({ rows, last: rows.at(-1)?.id ?? after });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/v1/records") return await postRecords(req, env);
      if (req.method === "POST" && url.pathname === "/v1/reports") return await postReport(req, env);
      if (req.method === "POST" && url.pathname === "/v1/forget") return await forget(req, env);
      if (req.method === "GET" && (url.pathname === "/v1/export" || url.pathname === "/v1/reports")) {
        if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
        return url.pathname === "/v1/export" ? await exportRecords(url, env) : await exportReports(url, env);
      }
      if (url.pathname === "/") return new Response("TLI Overlay collector\n");
      return json({ error: "not found" }, 404);
    } catch (err) {
      const bad = err instanceof SyntaxError || String(err).includes("too large");
      return json({ error: bad ? "bad request" : "server error" }, bad ? 400 : 500);
    }
  },
};
