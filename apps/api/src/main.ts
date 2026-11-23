import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { start } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const webRoot = join(here, "..", "..", "web", "public");

await start(port, webRoot);
console.log(`harness-cloud listening on http://localhost:${port}`);
