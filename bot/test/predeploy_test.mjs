// The production deploy gate. Wrangler accepts an arbitrary namespace id during a dry run, so fixture configs prove
// that placeholders, missing bindings and empty ids fail while a deployment-filled binding passes. The test does not
// freeze the repository config in either state: check-config is the command that evaluates that file before deploy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harness } from "./fakes.mjs";

const t = harness("predeploy");
const bot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(bot, "tools", "predeploy.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-predeploy-"));
const requiredSecrets = '[secrets]\nrequired = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]\n';
const privateAliases = 'workers_dev = false\npreview_urls = false\n';

const run = (body, options = []) => {
  const file = path.join(tmp, "wrangler.toml");
  fs.writeFileSync(file, body);
  return spawnSync(process.execPath, [gate, ...options, file], { encoding: "utf8" });
};

let r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "REPLACE_WITH_THE_LINTCHA_CHAIN_SESSIONS_NAMESPACE_ID"\n');
t.ok(r.status === 1 && /placeholder/.test(r.stderr), "the placeholder is refused by name");
r = run('name = "lintcha-chain-api"\n');
t.ok(r.status === 1 && /no non-empty SESSIONS/.test(r.stderr), "a missing namespace binding is refused");
r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\nid = ""\n');
t.ok(r.status === 1 && /no non-empty SESSIONS/.test(r.stderr), "an empty namespace id is refused");
r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\n[[kv_namespaces]]\nbinding = "OTHER"\nid = "other-id"\n');
t.ok(r.status === 1 && /no non-empty SESSIONS/.test(r.stderr), "a missing SESSIONS id cannot be borrowed from the next namespace");
r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n[vars]\nBOT_USERNAME = "wrong"\n');
t.ok(r.status === 1 && /BOT_USERNAME/.test(r.stderr), "an invalid configured bot username is refused before deployment");
r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n[vars]\nBOT_USERNAME = "lintcha_chain_bot"\n');
t.ok(r.status === 1 && /\[secrets\]\.required/.test(r.stderr), "a config without required secret names is refused before deployment");
r = run('[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n[secrets]\nrequired = ["TELEGRAM_BOT_TOKEN"]\n[vars]\nBOT_USERNAME = "lintcha_chain_bot"\n');
t.ok(r.status === 1 && /TELEGRAM_WEBHOOK_SECRET/.test(r.stderr), "requiring only one of the two secret bindings is refused");
r = run(privateAliases + '[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\n');
t.ok(r.status === 0 && /required secret names are filled/.test(r.stdout), "a filled binding and both required secret names pass without guessing their values");
r = run('workers_dev = true\npreview_urls = false\n[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\n');
t.ok(r.status === 1 && /workers_dev and preview_urls/.test(r.stderr), "an account-subdomain API deployment is refused");
r = run('workers_dev = false\npreview_urls = true\n[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\n');
t.ok(r.status === 1 && /workers_dev and preview_urls/.test(r.stderr), "a per-version public preview alias is refused");
r = run(privateAliases + '[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\nROOM_CHAT_ID = ""\n', ["--production"]);
t.ok(r.status === 1 && /ROOM_CHAT_ID/.test(r.stderr), "production refuses an empty room id before deployment");
r = run(privateAliases + '[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\nROOM_CHAT_ID = "not-a-chat"\n', ["--production"]);
t.ok(r.status === 1 && /ROOM_CHAT_ID/.test(r.stderr), "production refuses a non-decimal room id before deployment");
r = run(privateAliases + '[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "verified-in-the-deployment-session"\n' + requiredSecrets + '[vars]\nBOT_USERNAME = "lintcha_chain_bot"\nROOM_CHAT_ID = "-1001234567890"\n', ["--production"]);
t.ok(r.status === 0 && /production room id are filled/.test(r.stdout), "production accepts a discovered nonzero decimal room id");
fs.rmSync(tmp, { recursive: true, force: true });
t.done();
