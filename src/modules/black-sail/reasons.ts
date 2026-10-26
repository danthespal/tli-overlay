// One short reason per ranked card, in words, for the overlay and the watch output.
// It explains the combo model's verdict (09-card-advisor.md) without showing FE numbers.

import type { Ranked } from "./advisor.js";
import type { Material, Modifier } from "./modifiers.js";

const NAME: Record<Material, string> = { scraps: "Scrap", threads: "Thread", heroMemories: "Hero Memory", invitations: "invitation" };
const PLURAL: Record<Material, string> = { scraps: "Scraps", threads: "Threads", heroMemories: "Hero Memories", invitations: "invitations" };
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

/** Picked modifiers of one material (the ones a new card of that material combines with). */
const sameMaterial = (picked: Modifier[], mat: Material) => picked.filter((p) => "material" in p && p.material === mat);
const otherMaterials = (picked: Modifier[], mat: Material) =>
  [...new Set(picked.filter((p): p is Modifier & { material: Material } => "material" in p && p.material !== mat && p.material !== "invitations").map((p) => p.material))];

export function reasonFor(r: Ranked, picked: Modifier[], goalFocus: Material | undefined): string {
  const m = r.modifier;
  if (!("material" in m)) {
    if (m.kind === "rarity") return "rarity only: little value below gold";
    const stacked = picked.filter((p) => "material" in p && p.material !== "invitations").length;
    return stacked ? `boosts everything, incl. your ${plural(stacked, "material card")}` : "boosts every drop; no stack needed";
  }
  const name = NAME[m.material];
  const names = PLURAL[m.material];
  if (m.material === "invitations") return "invitations: rare, full value under any goal";
  const same = sameMaterial(picked, m.material).length;
  if (m.kind === "appear") {
    const others = otherMaterials(picked, m.material);
    if (others.length) return `moves base drops from ${others.map((o) => NAME[o]).join("/")} to ${name}`;
    return same ? `stacks with your ${plural(same, `${name} card`)}` : `more ${names} instead of other drops`;
  }
  if (m.kind === "flat" || m.kind === "chanceFlat") {
    // Extras are multiplied by doubling and "+% Drop Quantity" (the model's outer factor), not by quantity.
    if (picked.some((p) => p.kind === "multiply" && p.material === m.material)) return `extra ${names}, doubled by your ×2 card`;
    if (picked.some((p) => p.kind === "treasureQty")) return `extra ${names}, raised by your Drop Quantity card`;
    return `fixed extra ${names}, whatever else you pick`;
  }
  // qty / multiply: multiplies the material's base, so it grows with every same-material card.
  if (same) return `stacks with your ${plural(same, `${name} card`)}`;
  if (goalFocus === m.material) return `feeds your ${name} goal; stack more of it`;
  return `starts a ${name} stack; worth more with more ${name} cards`;
}
