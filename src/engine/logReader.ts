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
}

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
      }
    } catch {
      // Not there yet: poll() picks the file up from its first line once the game creates it.
    }
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 500);
    await this.poll();
  }

  stop(): void {
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
      }
      if (s.size === this.offset) return;

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
    const lines = (this.partial + chunk).split(/\r?\n/);
    this.partial = lines.pop()!; // last piece may be an unfinished line
    for (let raw of lines) {
      this.lineNo++;
      if (this.lineNo === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      this.onLine(parseLogLine(raw, this.lineNo));
    }
  }
}
