// The collector's address (worker/). Built into the exe; it holds no secret, since uploading needs
// no key. Running from source never shares unless TLI_SHARE_URL is set (e.g. a local `wrangler dev`),
// so test runs stay out of the data.
import { PACKAGED } from "../paths.js";

const LIVE = "https://tli-overlay-collector.danielplanteskole.workers.dev";

export const COLLECTOR = (process.env.TLI_SHARE_URL ?? (PACKAGED ? LIVE : "")).replace(/\/+$/, "");
