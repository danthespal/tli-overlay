// Compiles the overlay's main process into dist/overlay/main.js (the exe runs that instead of the
// TypeScript through tsx) and copies the window pages next to it. npm packages stay external:
// electron-builder ships them in node_modules.
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const out = "dist/overlay";
await rm("dist", { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/overlay/main.ts"],
  outfile: `${out}/main.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
for (const f of ["overlay.html", "preload.cjs", "capture.html", "capture-preload.cjs"]) await copyFile(`src/overlay/${f}`, `${out}/${f}`);
