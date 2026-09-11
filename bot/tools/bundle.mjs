// Run the pinned Wrangler through Node so the same command works on Windows and Linux. Its debug log and dry-run
// bundle both stay under the repository's ignored build directory rather than depending on a writable home folder.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(bot, "..");
const build = path.join(root, "build");
const wrangler = path.join(bot, "node_modules", "wrangler", "bin", "wrangler.js");

if (!fs.existsSync(wrangler)) {
  console.error("bundle: pinned Wrangler is not installed; run npm ci in bot/");
  process.exit(1);
}

fs.mkdirSync(build, { recursive: true });
const result = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", "--strict", "--outdir", path.join(build, "bot-dry-run")], {
  cwd: bot,
  env: { ...process.env, WRANGLER_LOG_PATH: path.join(build, "wrangler.log") },
  stdio: "inherit"
});

if (result.error) console.error("bundle: " + result.error.message);
process.exit(result.status === null ? 1 : result.status);
