// Reading UE_game.log: a one-shot reader for audits, and a tailer for live use.
// The game writes UTF-8 (with BOM) and rotates the file on each launch:
// the old one is renamed to UE_game-backup-<date>.log and a new UE_game.log is created.

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { parseLogLine, type LogLine } from "./logLine.js";

/**
 * Streams every line of a log file. Fast enough for 300 MB files (no full load into memory).
 * `bytes`: read only the first N bytes (what existed at some moment).
 */
export async function* readLogLines(path: string, bytes?: number): AsyncGenerator<LogLine> {
  if (bytes === 0) return;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8", end: bytes === undefined ? undefined : bytes - 1 }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (let raw of rl) {
    lineNo++;
    if (lineNo === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    yield parseLogLine(raw, lineNo);
  }
}

export interface TailerOptions {
  /** Start at the current end of file (live mode) instead of the beginning. Default true. */
  fromEnd?: boolean;
  pollMs?: number;
  /** With fromEnd: gets every line already in the file before tailing starts (e.g. to learn stack sizes). */
  prime?: (line: LogLine) => void;
  /** With fromEnd: called once priming is done, before the first new line is handled. */
  primed?: () => Promise<void> | void;
  /** The file appeared, was replaced (the game started a new log) or was cleared: reading restarts at its top. */
  onRotate?: () => void;
  /** A line handler threw: the error, then the next line goes on (default: console.error). */
  onError?: (err: unknown, line: LogLine) => void;
}

/** Bytes read per poll at most: after a jump (PC woke up, a big log swapped in) only the newest part is read. */
export const MAX_READ = 1024 * 1024;
/** Characters of an unfinished line kept between polls (a line can only be longer if the log was cleared mid-write). */
const MAX_LINE = 8192;

/**
 * Follows a growing log file by polling. Detects rotation (file replaced or truncated)
 * and restarts from the top of the new file.
 */
export class LogTailer {
  private offset = 0;
  private lineNo = 0;
  private partial = "";
  // Keeps multi-byte characters intact when a read ends mid-character.
  private decoder = new StringDecoder("utf8");
  private fileId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private stopped = false;
  /** After a jump the read starts mid-line: that cut piece (up to the first newline) is skipped. */
  private skipCut = false;

  constructor(
    private readonly path: string,
    private readonly onLine: (line: LogLine) => void,
    private readonly options: TailerOptions = {},
  ) {}

  /** True once the log file has been seen (it is missing until the game starts with logging on). */
  get hasFile(): boolean {
    return this.fileId !== undefined;
  }

  async start(): Promise<void> {
    try {
      const s = await stat(this.path);
      this.fileId = s.birthtimeMs;
      if (this.options.fromEnd ?? true) {
        this.offset = s.size;
        // Exactly the bytes before the tail start, so no line is both primed and tailed.
        if (this.options.prime) for await (const line of readLogLines(this.path, s.size)) this.options.prime(line);
        await this.options.primed?.();
      }
    } catch {
      // Not there yet: poll() picks the file up from its first line once the game creates it.
    }
    // stop() came while priming: no timer, or it would poll forever (stop() had none to clear).
    if (this.stopped) return;
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 500);
    await this.poll();
  }

  stop(): void {
    this.stopped = true; // a poll still in flight delivers nothing more
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads whatever was appended since the last call. Public so tests can drive it. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let s;
      try {
        s = await stat(this.path);
      } catch {
        return; // file briefly missing during rotation
      }
      if (s.birthtimeMs !== this.fileId || s.size < this.offset) {
        this.fileId = s.birthtimeMs;
        this.offset = 0;
        this.lineNo = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
        this.options.onRotate?.();
      }
      if (s.size === this.offset) return;
      if (s.size - this.offset > MAX_READ) {
        // Too much at once: skip to the newest part (its first, cut line is dropped with the rest).
        this.offset = s.size - MAX_READ;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
        this.skipCut = true;
      }

      const fh = await open(this.path, "r");
      try {
        const buf = Buffer.alloc(s.size - this.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        this.offset += bytesRead;
        this.emit(this.decoder.write(buf.subarray(0, bytesRead)));
      } finally {
        await fh.close();
      }
    } finally {
      this.busy = false;
    }
  }

  private emit(chunk: string): void {
    if (this.stopped) return;
    if (this.skipCut) {
      const nl = chunk.indexOf("\n");
      if (nl < 0) return; // still inside the cut line
      chunk = chunk.slice(nl + 1);
      this.skipCut = false;
    }
    const lines = (this.partial + chunk).split(/\r?\n/);
    this.partial = lines.pop()!.slice(-MAX_LINE); // last piece may be an unfinished line
    for (let raw of lines) {
      this.lineNo++;
      if (this.lineNo === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const line = parseLogLine(raw, this.lineNo);
      // One failing handler must not drop the rest of the batch (the offset is already past them).
      try {
        this.onLine(line);
      } catch (err) {
        if (this.options.onError) this.options.onError(err, line);
        else console.error(`log line ${line.lineNo}: ${err instanceof Error ? err.stack : err}`);
      }
    }
  }
}
