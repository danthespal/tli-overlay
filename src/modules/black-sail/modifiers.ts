// Turns a Seal Whisper effect text into a structured modifier for the combo model.
// Every effect in the table is one of 8 kinds (see mechanics/black-sail/09-card-advisor.md).

export type Material = "scraps" | "threads" | "heroMemories" | "invitations";
export const MATERIALS: Material[] = ["scraps", "threads", "heroMemories", "invitations"];

export type Modifier =
  /** +X% chance for the material to appear among base drops (fraction, e.g. 0.14). */
  | { kind: "appear"; material: Material; value: number }
  /** +X% additional drop quantity of the material in base drops. */
  | { kind: "qty"; material: Material; value: number }
  /** X% chance the material is multiplied by `times`. */
  | { kind: "multiply"; material: Material; chance: number; times: number }
  /** A fixed extra amount. */
  | { kind: "flat"; material: Material; amount: number }
  /** X% chance for `amount` extra. */
  | { kind: "chanceFlat"; material: Material; chance: number; amount: number }
  /** +X% to all base drops / all drops / item rarity. */
  | { kind: "baseQty" | "treasureQty" | "rarity"; value: number };

function material(s: string): Material | null {
  if (/scrap/.test(s)) return "scraps";
  if (/thread/.test(s)) return "threads";
  if (/hero memor/.test(s)) return "heroMemories";
  if (/invitation/.test(s)) return "invitations";
  return null;
}

const PATTERNS: [RegExp, (m: RegExpExecArray) => Modifier | null][] = [
  [/^\+(\d+)% void sea treasure base drop quantity/, (m) => ({ kind: "baseQty", value: +m[1]! / 100 })],
  [/^\+(\d+)% void sea treasure drop quantity/, (m) => ({ kind: "treasureQty", value: +m[1]! / 100 })],
  [/^\+(\d+)% void sea treasure drop rarity/, (m) => ({ kind: "rarity", value: +m[1]! / 100 })],
  [
    /^\+(\d+)% chance for (.+?) dropped from void sea treasures to be multiplied by (\d+)/,
    (m) => {
      const mat = material(m[2]!);
      return mat && { kind: "multiply", material: mat, chance: +m[1]! / 100, times: +m[3]! };
    },
  ],
  [/^\+(\d+)% chance for (.+?) to appear/, (m) => {
    const mat = material(m[2]!);
    return mat && { kind: "appear", material: mat, value: +m[1]! / 100 };
  }],
  [/^\+(\d+)% additional (.+?) drop quantity/, (m) => {
    const mat = material(m[2]!);
    return mat && { kind: "qty", material: mat, value: +m[1]! / 100 };
  }],
  [/^(\d+)% chance for (\d+) additional (.+?) to drop/, (m) => {
    const mat = material(m[3]!);
    return mat && { kind: "chanceFlat", material: mat, chance: +m[1]! / 100, amount: +m[2]! };
  }],
  [/^void sea treasures drop (\d+) additional (.+)/, (m) => {
    const mat = material(m[2]!);
    return mat && { kind: "flat", material: mat, amount: +m[1]! };
  }],
  [/^(\d+) additional (.+?) drop from void sea treasures/, (m) => {
    const mat = material(m[2]!);
    return mat && { kind: "flat", material: mat, amount: +m[1]! };
  }],
];

const MATERIAL_NAME: Record<Material, string> = {
  scraps: "Scraps",
  threads: "Threads",
  heroMemories: "Hero Mem",
  invitations: "Invitation",
};
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Short label for the overlay, e.g. "Scraps qty +53%", "Scraps +194 (20%)". */
export function describeModifier(m: Modifier): string {
  switch (m.kind) {
    case "appear": return `${MATERIAL_NAME[m.material]} chance +${pct(m.value)}`;
    case "qty": return `${MATERIAL_NAME[m.material]} qty +${pct(m.value)}`;
    case "multiply": return `${MATERIAL_NAME[m.material]} x${m.times} ${pct(m.chance)}`;
    case "flat": return `${MATERIAL_NAME[m.material]} +${m.amount}`;
    case "chanceFlat": return `${MATERIAL_NAME[m.material]} +${m.amount} (${pct(m.chance)})`;
    case "baseQty": return `Base drops +${pct(m.value)}`;
    case "treasureQty": return `All drops +${pct(m.value)}`;
    case "rarity": return `Rarity +${pct(m.value)}`;
  }
}

export function parseModifier(text: string): Modifier | null {
  const t = text.toLowerCase().replace(/^\+ (\d)/, "+$1").trim();
  for (const [re, make] of PATTERNS) {
    const m = re.exec(t);
    if (m) return make(m);
  }
  return null;
}
