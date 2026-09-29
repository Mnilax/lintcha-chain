import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Eip1193FinalityReadbackAdapter,
  FAILURE_TEXT,
  OUTCOME_TEXT,
  createApi,
  discoverPrivyBridge,
  formatNative,
  formatUnits,
  parseTelegramLaunch,
  resolvePrivyWallet,
  reviewLines,
  withTimeout,
} from "../copy/copy-app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("copy", "index.html");
const js = read("copy", "copy-app.js");
const css = read("copy", "copy-app.css");
const headers = read("_headers");
const count = (text, pattern) => (text.match(pattern) || []).length;

test("the sheet carries an immutable unified Lintcha copy-trading label that the script never touches", () => {
  assert.equal(count(html, /Lintcha — copy-trading<\/span>/g), 1);
  assert.match(html, /<header class="module-label" data-module-label>/);
  assert.match(html, /Lintcha Core remains read-only\./);
  assert.equal(/data-module-label|module-name|module-boundary/.test(js), false);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<title>Lintcha — copy-trading<\/title>/);
});

test("the browser fallback offers working canonical routes instead of a dead screen", () => {
  assert.match(html, /href="https:\/\/t\.me\/lintchabot\?start=copy_site"/);
  assert.match(html, /class="button primary"[^>]*>Open @lintchabot<\/a>/);
  assert.match(html, /class="button" href="\/">Back to lintcha\.com<\/a>/);
});

test("strict same-origin CSP, no third-party script, no storage, no analytics, no inline handlers", () => {
  assert.match(headers, /script-src 'self';/);
  assert.match(headers, /connect-src 'self';/);
  assert.match(headers, /style-src 'self';/);
  assert.match(headers, /default-src 'none'/);
  assert.match(headers, /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal(/telegram\.org\/js|cdn\.|googleapis|unpkg|jsdelivr/.test(html + js + css), false);
  assert.equal(/(?:localStorage|sessionStorage|indexedDB|\.cookie\b|sendBeacon|analytics|gtag\s*\(|navigator\.sendBeacon)/i.test(js), false);
  assert.equal(/\son[a-z]+="/i.test(html), false);
  assert.equal(/<style|style="/.test(html), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
  const resources = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)].map((match) => match[1]);
  assert.equal(resources.length > 0 && resources.every((url) => url.startsWith("/copy/")), true);
  assert.equal(/<(?:iframe|object|embed|form)\b/i.test(html), false);
  assert.equal(/fetchImpl\(`\$\{origin\}\$\{API\}/.test(js) && /const API = "\/api\/copy"/.test(js), true);
});

test("the page separates review, explicit confirm and cancel, and the sheet controller is the single audited copy", () => {
  assert.match(html, /data-action="confirm"/);
  assert.match(html, /data-action="cancel"/);
  assert.match(html, /Separate confirmation\./);
  assert.match(html, /SELL is manual: approval and trade are two separate wallet confirmations/);
  assert.equal(read("copy", "confirm-each.mjs"), fs.readFileSync(path.join(root, "..", "secure-sheet-crypto", "src", "confirm-each.mjs"), "utf8"));
  assert.match(js, /new ExternalEip1193WalletAdapter\(provider\)/);
  assert.equal(/seed|mnemonic|privateKey/.test(js.replace(/\/\/.*$/gm, "").replace(/Seed phrases and private keys never enter/g, "")), false);
});

test("auto-BUY wiring is first-party, identity-bound and exposes bounded limit controls without a form submit", async () => {
  for (const field of ["max-trade", "daily-cap", "slippage", "duration"]) assert.match(html, new RegExp(`data-auto-buy-input="${field}"`));
  assert.match(html, /data-action="activate-auto-buy"/);
  assert.match(html, /data-action="deactivate-auto-buy"/);
  assert.match(html, /data-auto-buy-status/);
  assert.match(html, /data-auto-buy-error/);
  assert.match(js, /new AutoBuySetupController/);
  assert.match(js, /windowLike\?\.lintchaPrivy/);

  const walletAddress = `0x${"1".repeat(40)}`;
  const publicConfig = Object.freeze({ privyAppId: "privy_app_123", signerId: "signer_12345678", policyId: "policy_12345678", wrapperAddress: `0x${"7".repeat(40)}`, chainId: 4663 });
  const provider = { async request({ method }) { return method === "eth_accounts" ? [walletAddress] : null; } };
  const source = {
    publicConfig,
    async getWallet() { return { walletAddress, telegramUserId: "42", provider }; },
    async addSigners() {},
    async getSignerState() { return { walletAddress, additionalSigners: [{ signerId: publicConfig.signerId, policyIds: [publicConfig.policyId] }] }; },
    async removeSigners() {},
  };
  const bridge = discoverPrivyBridge({ lintchaPrivy: source, ethereum: { request() { throw new Error("MUST_NOT_USE_GENERIC_PROVIDER"); } } }, publicConfig);
  assert.ok(bridge);
  assert.deepEqual(await resolvePrivyWallet(bridge, "42"), { walletAddress, provider });
  assert.equal(discoverPrivyBridge({ lintchaPrivy: source }, { ...publicConfig, policyId: "policy_tampered" }), null);
  await assert.rejects(resolvePrivyWallet({ ...bridge, getWallet: async () => ({ walletAddress, telegramUserId: "99", provider }) }, "42"), /TELEGRAM_IDENTITY_MISMATCH/);
  await assert.rejects(resolvePrivyWallet({ ...bridge, getWallet: async () => ({ walletAddress, telegramUserId: "42", provider: { async request() { return [`0x${"2".repeat(40)}`]; } } }) }, "42"), /ACCOUNT_MISMATCH/);
});

test("EIP-1193 finality waits for the finalized receipt block and reads wrapper limits at that exact block", async () => {
  const walletAddress = `0x${"1".repeat(40)}`;
  const wrapperAddress = `0x${"7".repeat(40)}`;
  const transactionHash = `0x${"a".repeat(64)}`;
  const blockHash = `0x${"b".repeat(64)}`;
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const encoded = `0x${word(5)}${word(20)}${word(100)}${word(1_700_003_600)}${word(0)}`;
  let finalizedReads = 0;
  const calls = [];
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === "eth_chainId") return "0x1237";
      if (request.method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x64", from: walletAddress, to: wrapperAddress };
      if (request.method === "eth_getBlockByNumber") return { number: finalizedReads++ ? "0x64" : "0x63", hash: blockHash };
      if (request.method === "eth_call") return encoded;
      throw new Error("UNEXPECTED_METHOD");
    },
  };
  const adapter = new Eip1193FinalityReadbackAdapter(provider, { maxAttempts: 3, pollIntervalMs: 0, wait: async () => {} });
  const result = await adapter.waitForFinalizedReadback({ transactionHash, walletAddress, wrapperAddress });
  assert.deepEqual(result.readback, { maxPerTradeWei: "5", maxDailyWei: "20", maxSlippageBps: 100, expiresAt: 1_700_003_600, paused: false });
  assert.equal(result.blockNumber, 100);
  const read = calls.find((call) => call.method === "eth_call");
  assert.equal(read.params[0].to, wrapperAddress);
  assert.equal(read.params[0].data, `0x20d7bec1${walletAddress.slice(2).padStart(64, "0")}`);
  assert.equal(read.params[1], "0x64");
});

test("EIP-1193 finality polling is bounded and never broadcasts", async () => {
  const methods = [];
  const provider = { async request({ method }) { methods.push(method); if (method === "eth_chainId") return "0x1237"; if (method === "eth_getTransactionReceipt") return null; throw new Error("UNEXPECTED_METHOD"); } };
  const adapter = new Eip1193FinalityReadbackAdapter(provider, { maxAttempts: 2, pollIntervalMs: 0, wait: async () => {} });
  await assert.rejects(adapter.waitForFinalizedReadback({ transactionHash: `0x${"a".repeat(64)}`, walletAddress: `0x${"1".repeat(40)}`, wrapperAddress: `0x${"7".repeat(40)}` }), /FINALITY_TIMEOUT/);
  assert.equal(methods.filter((method) => method === "eth_getTransactionReceipt").length, 2);
  assert.equal(methods.includes("eth_sendTransaction"), false);
});

test("launch parsing, unit formatting and review lines are exact", () => {
  const initData = "query_id=q&user=%7B%22id%22%3A42%7D&auth_date=1&hash=ff&signature=sig&start_param=intent_abc";
  const launch = parseTelegramLaunch(`#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppPlatform=ios`);
  assert.equal(launch.userId, "42");
  assert.equal(launch.initData, initData);
  assert.equal(launch.startParam, "intent_abc");
  assert.equal(parseTelegramLaunch(""), null);
  assert.equal(parseTelegramLaunch("#tgWebAppData=user%3Dnope").userId, null);
  assert.equal(formatUnits("39322474350183024"), "0.039322");
  assert.equal(formatUnits("1000000000000000000"), "1");
  assert.equal(formatUnits("0"), "0");
  const lines = reviewLines({ label: "Lintcha — copy-trading", direction: "BUY", operation: "TRADE", chainId: 4663, token: "0x" + "3".repeat(40), amountIn: "39322474350183024", minimumOutput: "1", slippageBps: 50, target: "0x" + "2".repeat(40), selector: "0x59a87bc1", value: "39322474350183024", simulationBlock: 65697020, expiresAt: 1700000000 });
  assert.deepEqual(lines.map(([key]) => key), ["Mode", "Action", "Chain", "Token", "Amount in", "Minimum out", "Slippage cap", "Target contract", "Selector", "Native value", "Simulated at block", "Expires"]);
  assert.equal(lines[4][1], "0.039322 ETH");
  assert.equal(lines[6][1], "0.50%");
});

test("a sheet whose script never arrives still offers a way out, with or without its stylesheet", () => {
  // The loading view is the only one the page starts on, so it carries its own rescue: revealed by CSS timing,
  // needing no script at all. Everything else is hidden by attribute as well as by class, so a page served
  // without its stylesheet shows one view instead of stacking six with live-looking buttons.
  const loading = /<section data-view="loading">([\s\S]*?)<\/section>/.exec(html)[1];
  assert.match(loading, /data-boot-fallback/);
  assert.match(loading, /href="https:\/\/t\.me\/lintchabot\?start=copy_site"/);
  assert.match(loading, /href="\/"/);
  assert.match(css, /\.boot-fallback\s*\{[^}]*animation:/);
  assert.match(css, /@keyframes boot-rescue/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none/);
  for (const view of ["unauthenticated", "error", "home", "review", "result"]) {
    assert.match(html, new RegExp(`<section data-view="${view}" class="hidden" hidden>`), view);
  }
  assert.equal(count(html, /<section data-view="[a-z]+"(?! class="hidden" hidden)/g), 1);
  assert.match(js, /view\.hidden = hidden;/);
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)[1];
  assert.match(noscript, /href="https:\/\/t\.me\/lintchabot\?start=copy_site"/);
  assert.match(noscript, /Nothing is signed without it\./);
});

test("a stopped sheet says what happened in words, keeps the code, and is not a dead end", () => {
  assert.match(html, /data-error-message/);
  assert.match(html, /data-action="retry"/);
  const error = /<section data-view="error"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(error, /href="https:\/\/t\.me\/lintchabot\?start=copy_site"/);
  assert.match(error, /href="\/"/);
  for (const code of ["COPY_API_TIMEOUT", "COPY_API_UNREACHABLE", "USER_REJECTED_IN_WALLET", "WALLET_CHAIN_MISMATCH", "CONFIRMATION_EXPIRED"]) {
    assert.equal(typeof FAILURE_TEXT[code], "string", code);
    assert.ok(FAILURE_TEXT[code].length > 20, code);
  }
});

test("a request that never answers becomes a visible failure instead of an endless loading view", async () => {
  // The call must carry a real abort signal: a stub that only settles on abort proves the sheet cannot hang.
  // (AbortSignal.timeout does not hold the loop open on its own, so the test keeps one live timer of its own.)
  let carried = null;
  const hang = createApi({
    fetchImpl: (url, init) => { carried = init.signal; return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))); },
    origin: "https://copy.example.invalid", initData: "x", timeoutMs: 20,
  });
  const pending = hang.me();
  const keepAlive = setTimeout(() => {}, 2000);
  await assert.rejects(pending, /COPY_API_TIMEOUT/);
  clearTimeout(keepAlive);
  assert.ok(carried instanceof AbortSignal);
  const timedOut = createApi({ fetchImpl: () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), origin: "https://copy.example.invalid", initData: "x" });
  await assert.rejects(timedOut.me(), /COPY_API_TIMEOUT/);
  const offline = createApi({ fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")), origin: "https://copy.example.invalid", initData: "x" });
  await assert.rejects(offline.me(), /COPY_API_UNREACHABLE/);
  const refused = createApi({ fetchImpl: async () => new Response("<html>nope", { status: 502 }), origin: "https://copy.example.invalid", initData: "x" });
  await assert.rejects(refused.me(), /HTTP_502/);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "PRIVY_WALLET_TIMEOUT"), /PRIVY_WALLET_TIMEOUT/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, "NEVER"), "ok");
});

test("an amount below display precision is stated exactly, never rounded to a flat zero", () => {
  assert.equal(formatNative("500"), "500 wei");
  assert.equal(formatNative("0"), "0 ETH");
  assert.equal(formatNative("39322474350183024"), "0.039322 ETH");
  const tiny = reviewLines({ direction: "BUY", operation: "TRADE", chainId: 4663, token: `0x${"3".repeat(40)}`, amountIn: "500", minimumOutput: "1", slippageBps: 50, target: `0x${"2".repeat(40)}`, selector: "0x59a87bc1", value: "500", simulationBlock: 1, expiresAt: 1700000000 });
  assert.equal(tiny.find(([key]) => key === "Amount in")[1], "500 wei");
  assert.equal(tiny.find(([key]) => key === "Native value")[1], "500 wei");
});

test("once the module script runs it owns the screen: the did-not-load rescue is switched off", () => {
  // The rescue exists for a page whose script never arrives. A slow API is a different failure and must not
  // borrow its wording, so the module marks the document as soon as it executes and CSS stops the reveal.
  assert.match(css, /\[data-copy-boot\]\s+\.boot-fallback\s*\{[^}]*animation:\s*none/);
  const marker = js.indexOf('document.documentElement.setAttribute("data-copy-boot"');
  const bootCall = js.indexOf("boot().catch(");
  assert.ok(marker > 0, "the module sets the boot marker");
  assert.ok(marker < bootCall, "the marker is set before boot runs, not after it resolves");
  assert.equal(/setTimeout\([^)]*boot-fallback|data-boot-fallback/.test(js), false, "the rescue stays CSS-only");
  // The rescue itself is unchanged for the no-script case.
  assert.match(css, /\.boot-fallback\s*\{[^}]*animation:\s*boot-rescue/);
});

test("Cancel is described exactly: no wallet, no transaction, but the review is released on the backend", () => {
  assert.match(html, /Cancel does not open the wallet and does not submit a transaction\. It only closes the pending review and releases it on the Lintcha backend\./);
  assert.match(html, /data-action="cancel">Cancel review</);
  assert.match(OUTCOME_TEXT.CANCELLED[1], /wallet was not opened/);
  assert.match(OUTCOME_TEXT.CANCELLED[1], /no transaction was submitted/);
  assert.match(OUTCOME_TEXT.CANCELLED[1], /released on the Lintcha backend/);
  // The cancellation route itself stays: the sheet must tell the server, otherwise the reservation leaks.
  const sheet = read("copy", "confirm-each.mjs");
  assert.match(sheet, /copyApi\.cancel\?\.\(\{ intentId: intent\.intentId, userId, reason: "USER_CANCELLED" \}\)/);
  assert.match(sheet, /Cancel never opens the\s*\n\s*\*\s*wallet and never submits a transaction/);
});
