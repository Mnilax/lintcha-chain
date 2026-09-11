// Refuse a production deploy while wrangler.toml still names a placeholder resource. Wrangler's own dry run
// deliberately accepts that string, so compilation alone cannot catch a Worker that would be wired to nowhere.
// Secrets and live migration history cannot be proven from this tree and remain deployment smoke checks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { botUsernameOf } from "../src/config.js";

const bot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
let production = false, configArgument = null;
for (const argument of argv) {
  if (argument === "--production") {
    if (production) { console.error("predeploy: duplicate --production argument"); process.exit(1); }
    production = true;
  } else if (argument.startsWith("--") || configArgument) {
    console.error("predeploy: usage: node tools/predeploy.mjs [--production] [wrangler.toml]");
    process.exit(1);
  } else configArgument = argument;
}
const configPath = configArgument ? path.resolve(process.cwd(), configArgument) : path.join(bot, "wrangler.toml");
const config = fs.readFileSync(configPath, "utf8");
const placeholder = "REPLACE_WITH_THE_LINTCHA_CHAIN_SESSIONS_NAMESPACE_ID";
const requiredSecrets = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"];

if (config.includes(placeholder)) {
  console.error("predeploy: SESSIONS still points at the placeholder in bot/wrangler.toml");
  process.exit(1);
}

// Keep each TOML table separate. A missing id on SESSIONS must not borrow an id from the next namespace (or from
// any later table), regardless of key order inside its own block.
const kvTables = [];
let table = null;
for (const line of config.split(/\r?\n/)) {
  const header = /^\s*\[{1,2}[A-Za-z0-9_.-]+\]{1,2}\s*(?:#.*)?$/.test(line);
  if (header) {
    if (table) kvTables.push(table.join("\n"));
    table = /^\s*\[\[kv_namespaces\]\]\s*(?:#.*)?$/.test(line) ? [] : null;
  } else if (table) table.push(line);
}
if (table) kvTables.push(table.join("\n"));

const sessions = kvTables.find(body => /^\s*binding\s*=\s*"SESSIONS"\s*(?:#.*)?$/m.test(body));
const binding = sessions && /^\s*id\s*=\s*"([^"]*)"\s*(?:#.*)?$/m.exec(sessions);
if (!binding || !binding[1].trim()) {
  console.error("predeploy: no non-empty SESSIONS namespace id in bot/wrangler.toml");
  process.exit(1);
}

const username = /^\s*BOT_USERNAME\s*=\s*"([^"]*)"\s*(?:#.*)?$/m.exec(config);
if (!username || !botUsernameOf(username[1])) {
  console.error("predeploy: BOT_USERNAME must be the exact 5-32 character BotFather username without @ and ending in bot");
  process.exit(1);
}

// Wrangler can inherit a deployed/staged secret without placing its value in this file, but only when the binding
// name is declared as required. Keep this deliberately small parser bounded to one plain [secrets] table and one
// JSON-compatible string array: the checked-in shape is strict, and Wrangler remains the final TOML parser.
const secretTables = [];
let secretTable = null;
for (const line of config.split(/\r?\n/)) {
  const header = /^\s*\[{1,2}[A-Za-z0-9_.-]+\]{1,2}\s*(?:#.*)?$/.test(line);
  if (header) {
    if (secretTable) secretTables.push(secretTable.join("\n"));
    secretTable = /^\s*\[secrets\]\s*(?:#.*)?$/.test(line) ? [] : null;
  } else if (secretTable) secretTable.push(line);
}
if (secretTable) secretTables.push(secretTable.join("\n"));

let configuredSecrets = null;
if (secretTables.length === 1) {
  const required = /^\s*required\s*=\s*(\[[^\r\n]*\])\s*(?:#.*)?$/m.exec(secretTables[0]);
  if (required) {
    try { configuredSecrets = JSON.parse(required[1]); }
    catch { configuredSecrets = null; }
  }
}
const exactRequiredSecrets = Array.isArray(configuredSecrets) &&
  configuredSecrets.length === requiredSecrets.length &&
  requiredSecrets.every(name => configuredSecrets.includes(name)) &&
  new Set(configuredSecrets).size === configuredSecrets.length;
if (!exactRequiredSecrets) {
  console.error("predeploy: [secrets].required must name exactly TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET");
  process.exit(1);
}

const topLevelConfig = [];
for (const line of config.split(/\r?\n/)) {
  if (/^\s*\[/.test(line)) break;
  topLevelConfig.push(line);
}
const topLevel = topLevelConfig.join("\n");
if (!/^\s*workers_dev\s*=\s*false\s*(?:#.*)?$/m.test(topLevel) ||
    !/^\s*preview_urls\s*=\s*false\s*(?:#.*)?$/m.test(topLevel)) {
  console.error("predeploy: workers_dev and preview_urls must both be explicitly false");
  process.exit(1);
}

if (production) {
  const room = /^\s*ROOM_CHAT_ID\s*=\s*"([^"]*)"\s*(?:#.*)?$/m.exec(config);
  if (!room || !/^-?[1-9][0-9]*$/.test(room[1])) {
    console.error("predeploy: production ROOM_CHAT_ID must be a nonzero decimal chat id discovered from Telegram");
    process.exit(1);
  }
}

console.log("predeploy: local resource bindings and required secret names" + (production ? " and production room id are" : " are") + " filled; secret values, migrations and dashboard-level route admission still require live checks");
