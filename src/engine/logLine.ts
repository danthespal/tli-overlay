// One physical line of UE_game.log, split into its header parts.
//
// Typical line:
//   [2026.10.24-20.12.23:858][213]TLLua: Display: [Game] ItemChange@ ProtoName=PickItems start
// Continuation lines (multi-line dumps) have no header:
//   +Description [This stage has been marked by a Plane Anchor]

export interface LogLine {
  lineNo: number;
  /** Epoch ms. The game writes UTC timestamps. Undefined for continuation lines. */
  time?: number;
  category?: string;
  verbosity?: string;
  /** Message with the header, verbosity and "[Game] " prefix removed. */
  text: string;
  raw: string;
}

const HEADER =
  /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]\[\s*\d+\]([A-Za-z0-9_]+): (.*)$/;
const VERBOSITY = /^(Display|Warning|Error|Log|Verbose|Fatal): (.*)$/;

export function parseLogLine(raw: string, lineNo: number): LogLine {
  const m = HEADER.exec(raw);
  if (!m) return { lineNo, text: raw, raw };

  const [, y, mo, d, h, mi, s, ms, category, rest] = m as unknown as string[];
  const time = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms!);

  let text = rest!;
  let verbosity: string | undefined;
  const v = VERBOSITY.exec(text);
  if (v) {
    verbosity = v[1];
    text = v[2]!;
  }
  if (text.startsWith("[Game] ")) text = text.slice(7);

  return { lineNo, time, category, verbosity, text, raw };
}
