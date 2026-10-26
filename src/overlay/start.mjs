// Electron entry point: lets the main process run our TypeScript directly (same code as the CLI).
import { register } from "tsx/esm/api";

register();
await import("./main.ts");
