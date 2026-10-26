// Where the tool's files are.
//   From source (npm scripts, tests, `npm run overlay`): everything is in the tool folder.
//   Packaged exe: the shipped files (scripts, OCR model, tables) are in the app's resources, and the
//   player's own files (history, dataset, calibrated config) go in a "data" folder next to the exe.

import { dirname, join, resolve } from "node:path";

/** True inside the built exe (not `electron start.mjs`, not Node). */
export const PACKAGED = !!process.versions.electron && !process.defaultApp && typeof process.resourcesPath === "string";

/** Read-only files shipped with the tool: scripts/, data/black-sail/, data/tessdata-fast/. */
export const APP_DIR = PACKAGED ? process.resourcesPath : resolve(import.meta.dirname, "..");

/** The player's files. The portable exe runs from a temp copy; PORTABLE_EXECUTABLE_DIR is where the .exe really is. */
export const USER_DIR = PACKAGED ? join(process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath), "data") : join(APP_DIR, "data");
