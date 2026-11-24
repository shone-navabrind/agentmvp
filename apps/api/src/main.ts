import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { start } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const webRoot = join(here, "..", "..", "web", "public");
const demo = process.env.HARNESS_DEMO === "1";
const dataDir = resolve(process.env.HARNESS_DATA_DIR ?? join(here, "..", "..", "..", ".data"));

const databaseUrl = process.env.DATABASE_URL || undefined;

await start(port, webRoot, { demo, dataDir, databaseUrl });
console.log(
  `harness-cloud listening on http://localhost:${port} — ${demo ? "demo scenario (read-only)" : `data in ${databaseUrl ? "Postgres" : "PGlite"}, files in ${dataDir}`}`,
);
