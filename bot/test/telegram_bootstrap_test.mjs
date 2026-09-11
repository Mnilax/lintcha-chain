// Offline contract tests for the production Telegram bootstrap helper. Every credential below is an
// unmistakable fixture; no test opens a network connection or reads argv/environment credentials. The one
// file read binds the helper's expected username to the checked-in deployment configuration.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { harness } from "./fakes.mjs";
import { TOKEN_CONFIG_BODY_LIMIT } from "../../lib/config-contract.mjs";
import { TELEGRAM_RESPONSE_LIMIT, TELEGRAM_TIMEOUT_MS } from "../src/telegram.js";
import {
  BOT_TOKEN_INPUT_LIMIT,
  DISCOVERY_CHAT,
  EXPECTED_BOT_USERNAME,
  PRODUCTION_ALLOWED_UPDATES,
  PRODUCTION_TOKEN_JSON_URL,
  PRODUCTION_WEBHOOK_URL,
  WEBHOOK_SECRET_INPUT_LIMIT,
  botApiRequest,
  deleteProductionWebhook,
  discoverProductionChat,
  productionWebhookInfo,
  readMasked,
  requireProductionToken,
  runCli,
  setProductionWebhook,
  validBotToken,
  validWebhookSecret
} from "../tools/telegram-bootstrap.mjs";

const t = harness("telegram_bootstrap");
const TOKEN = "123456:OFFLINE_FAKE_TOKEN";
const SECRET = "OFFLINE_TEST_WEBHOOK_SECRET";
const ACTIVE_ADDRESS = "0x" + "1".repeat(40);
const ACTIVE_TOKEN = { address: ACTIVE_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
const ME = {
  id: 1,
  is_bot: true,
  username: "LintchaBot",
  can_join_groups: true,
  can_read_all_group_messages: false
};

const response = (result, init = {}) => new Response(JSON.stringify({ ok: true, result }), {
  status: init.status || 200,
  headers: { "content-type": "application/json", ...(init.headers || {}) }
});
const tokenResponse = (value, init = {}) => new Response(
  typeof value === "string" ? value : JSON.stringify(value),
  { status: init.status || 200, headers: { "content-type": "application/json", ...(init.headers || {}) } }
);
const activeTokenFetch = async () => tokenResponse(ACTIVE_TOKEN);
const webhook = url => ({ url, has_custom_certificate: false, pending_update_count: 0 });
const rejected = promise => promise.then(() => null, error => error);
const generic = error => error && error.message === "telegram bootstrap failed" &&
  !JSON.stringify(error).includes(TOKEN) && !JSON.stringify(error).includes(SECRET);

t.ok(EXPECTED_BOT_USERNAME === "lintchabot" && DISCOVERY_CHAT === "@lintcha", "production identity constants are exact");
t.ok(PRODUCTION_WEBHOOK_URL === "https://chain.lintcha.com/api/telegram", "the production webhook target is exact HTTPS");
t.ok(PRODUCTION_TOKEN_JSON_URL === "https://chain.lintcha.com/token.json", "webhook activation reads only the fixed public token document");
t.ok(JSON.stringify(PRODUCTION_ALLOWED_UPDATES) === JSON.stringify(["message", "edited_message"]), "only handled update kinds are requested");
t.ok(validBotToken(TOKEN) && !validBotToken("") && !validBotToken("no-colon") && !validBotToken("0:suffix") &&
  !validBotToken("01:suffix") && !validBotToken("1:") && !validBotToken("1:two:colons") &&
  !validBotToken("1:bad/token"), "bot tokens require one colon, a nonzero decimal prefix and a nonempty path-safe suffix");
t.ok(validBotToken("1:" + "a".repeat(BOT_TOKEN_INPUT_LIMIT - 2)) &&
  !validBotToken("1:" + "a".repeat(BOT_TOKEN_INPUT_LIMIT - 1)), "bot token validation has an explicit implementation safety ceiling");
t.ok(validWebhookSecret(SECRET) && validWebhookSecret("a".repeat(WEBHOOK_SECRET_INPUT_LIMIT)) &&
  !validWebhookSecret("") && !validWebhookSecret("a".repeat(WEBHOOK_SECRET_INPUT_LIMIT + 1)) &&
  !validWebhookSecret("has:colon"), "webhook secrets follow Telegram's documented alphabet and length");

{
  const wrangler = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const configured = [...wrangler.matchAll(/^\s*BOT_USERNAME\s*=\s*"([^"]*)"\s*$/gm)];
  t.ok(configured.length === 1 && configured[0][1] === EXPECTED_BOT_USERNAME,
    "the helper identity and checked-in BOT_USERNAME cannot drift");
}

{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/getMe")) return response(ME);
    if (url.endsWith("/getChat")) return response({ id: -100, type: "supergroup", username: "Lintcha" });
    throw new Error("unexpected offline request");
  };
  const found = await discoverProductionChat({ token: TOKEN, fetchImpl });
  t.ok(calls.length === 2 && calls.every(call => call.init.method === "POST"), "discover uses exactly getMe then getChat as JSON POSTs");
  t.ok(JSON.parse(calls[0].init.body) && Object.keys(JSON.parse(calls[0].init.body)).length === 0,
    "getMe receives no accidental parameters");
  t.ok(JSON.stringify(JSON.parse(calls[1].init.body)) === JSON.stringify({ chat_id: "@lintcha" }), "getChat is fixed to the public room username");
  t.ok(found.chat.id === -100 && found.chat.username === "@lintcha" && found.bot.username === "lintchabot", "discover returns only the verified numeric chat id and safe identity fields");
  t.ok(!JSON.stringify(found).includes(TOKEN), "discover output cannot contain the bot token");
}

{
  const wrong = await rejected(discoverProductionChat({
    token: TOKEN,
    fetchImpl: async url => url.endsWith("/getMe")
      ? response({ id: 1, is_bot: true, username: "anotherbot" })
      : response({ id: -100, type: "supergroup", username: "lintcha" })
  }));
  t.ok(generic(wrong), "discover fails generically when getMe is not the configured bot");
}

{
  let telegramCalls = 0;
  for (const [label, tokenFetchImpl] of [
    ["null activation", async () => tokenResponse({ address: null, pons: null, uniswap: null })],
    ["malformed activation", async () => tokenResponse("{")],
    ["network failure", async () => { throw new Error("offline fixture failure"); }],
    ["redirect", async (_url, init) => {
      t.ok(init.redirect === "error", "the activation read asks fetch to reject redirects");
      return new Response(null, { status: 302, headers: { location: "https://foreign.invalid/token.json" } });
    }]
  ]) {
    const error = await rejected(setProductionWebhook({
      token: TOKEN,
      secret: SECRET,
      tokenFetchImpl,
      fetchImpl: async () => { telegramCalls++; return response(true); }
    }));
    t.ok(generic(error), label + " blocks webhook activation with a redacted failure");
  }
  t.ok(telegramCalls === 0, "a refused activation document prevents every Bot API request");
}

{
  let deadline;
  let signal;
  const pending = requireProductionToken({
    tokenFetchImpl: async (_url, init) => { signal = init.signal; return await new Promise(() => {}); },
    setTimer(fn, ms) { deadline = { fn, ms }; return 1; },
    clearTimer() {}
  });
  await Promise.resolve();
  deadline.fn();
  const error = await rejected(pending);
  t.ok(deadline.ms === TELEGRAM_TIMEOUT_MS && signal.aborted === true && generic(error), "a hanging activation read stops at the authored deadline and aborts fetch");
}

{
  let cancelCalls = 0;
  const body = new ReadableStream({ cancel() { cancelCalls++; } });
  const error = await rejected(requireProductionToken({
    tokenFetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(TOKEN_CONFIG_BODY_LIMIT + 1) }
    })
  }));
  t.ok(cancelCalls === 1 && generic(error), "an oversized activation response is cancelled at the shared token-config byte ceiling");
}

{
  const calls = [];
  const tokenCalls = [];
  const result = await setProductionWebhook({
    token: TOKEN,
    secret: SECRET,
    tokenFetchImpl: async (url, init) => { tokenCalls.push({ url, init }); return activeTokenFetch(); },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(url.endsWith("/getMe") ? ME : true); }
  });
  const body = JSON.parse(calls[1].init.body);
  t.ok(tokenCalls.length === 1 && tokenCalls[0].url === PRODUCTION_TOKEN_JSON_URL && tokenCalls[0].init.method === "GET" &&
    tokenCalls[0].init.redirect === "error" && tokenCalls[0].init.cache === "no-store", "set mode proves a non-null public activation before contacting Telegram");
  t.ok(calls.length === 2 && calls[0].url.endsWith("/getMe") && calls[1].url.endsWith("/setWebhook"),
    "set mode verifies the production bot before its one setWebhook call");
  t.ok(calls.every(call => call.init.redirect === "error"), "every Bot API request refuses HTTP redirects");
  t.ok(JSON.stringify(body) === JSON.stringify({
    url: "https://chain.lintcha.com/api/telegram",
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: false,
    secret_token: SECRET
  }), "setWebhook sends the exact production URL, update list, preservation flag and secret");
  t.ok(JSON.stringify(result) === JSON.stringify({
    url: "https://chain.lintcha.com/api/telegram",
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: false
  }) && !JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(TOKEN), "set output contains safe fields only");
}

{
  let setCalls = 0;
  const error = await rejected(setProductionWebhook({
    token: TOKEN,
    secret: SECRET,
    tokenFetchImpl: activeTokenFetch,
    fetchImpl: async url => {
      if (url.endsWith("/setWebhook")) setCalls++;
      return response({ id: 1, is_bot: true, username: "anotherbot" });
    }
  }));
  t.ok(setCalls === 0 && generic(error), "a token for another bot cannot change that bot's webhook");
}

{
  let payload;
  const calls = [];
  const result = await deleteProductionWebhook({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (url.endsWith("/getMe")) return response(ME);
      if (url.endsWith("/getWebhookInfo")) return response(webhook(PRODUCTION_WEBHOOK_URL));
      payload = JSON.parse(init.body);
      return response(true);
    }
  });
  t.ok(calls.length === 3 && calls[1].endsWith("/getWebhookInfo") && calls[2].endsWith("/deleteWebhook"),
    "delete verifies the current webhook before changing it");
  t.ok(JSON.stringify(payload) === JSON.stringify({ drop_pending_updates: false }), "deleteWebhook explicitly preserves pending updates");
  t.ok(result.deleted === true && result.drop_pending_updates === false && Object.keys(result).length === 2,
    "successful delete output is minimal and safe");
}

{
  let deleteCalls = 0;
  const result = await deleteProductionWebhook({
    token: TOKEN,
    fetchImpl: async url => {
      if (url.endsWith("/getMe")) return response(ME);
      if (url.endsWith("/deleteWebhook")) deleteCalls++;
      return response(webhook(""));
    }
  });
  t.ok(deleteCalls === 0 && result.deleted === false && result.drop_pending_updates === false,
    "an empty current webhook is an explicit safe no-op");
}

{
  let deleteCalls = 0;
  const error = await rejected(deleteProductionWebhook({
    token: TOKEN,
    fetchImpl: async url => {
      if (url.endsWith("/getMe")) return response(ME);
      if (url.endsWith("/deleteWebhook")) deleteCalls++;
      return response(webhook("https://foreign.invalid/hook?secret=" + SECRET));
    }
  }));
  t.ok(deleteCalls === 0 && generic(error), "a foreign webhook URL fails closed and is never deleted");
}

{
  const result = await productionWebhookInfo({
    token: TOKEN,
    fetchImpl: async url => url.endsWith("/getMe") ? response(ME) : response({
        url: PRODUCTION_WEBHOOK_URL + "?old=" + SECRET,
        has_custom_certificate: false,
        pending_update_count: 2,
        max_connections: 40,
        allowed_updates: ["message"],
        last_error_date: 1,
        last_error_message: "remote text " + TOKEN + " " + SECRET
      })
  });
  const shown = JSON.stringify(result);
  t.ok(result.configured === true && result.matches_production === false && result.has_last_error_message === true,
    "webhook-info reports state without repeating a mismatched URL or Telegram error text");
  t.ok(!shown.includes(TOKEN) && !shown.includes(SECRET) && !shown.includes("remote text") && !shown.includes("?old="),
    "webhook-info output redacts token, secret, URL query and remote error body");
}

{
  const apiError = await rejected(botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: TOKEN + SECRET }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }));
  const malformed = await rejected(botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async () => new Response("not-json", { status: 200 })
  }));
  t.ok(generic(apiError) && generic(malformed), "Bot API refusal and malformed JSON both become generic redacted failures");
}

{
  let calls = 0;
  let redirect;
  const error = await rejected(botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async (_url, init) => {
      calls++;
      redirect = init.redirect;
      return new Response(null, { status: 302, headers: { location: "https://foreign.invalid/" } });
    }
  }));
  t.ok(calls === 1 && redirect === "error" && generic(error), "a redirect response is refused without a follow-up request");
}

{
  let deadline;
  let signal;
  const pending = botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async (_url, init) => { signal = init.signal; return await new Promise(() => {}); },
    setTimer(fn, ms) { deadline = { fn, ms }; return 1; },
    clearTimer() {}
  });
  await Promise.resolve();
  deadline.fn();
  const error = await rejected(pending);
  t.ok(deadline.ms === TELEGRAM_TIMEOUT_MS && signal.aborted === true && generic(error), "a hanging request stops at the authored deadline and aborts the fetch");
}

{
  let cancelCalls = 0;
  const body = new ReadableStream({ cancel() { cancelCalls++; return new Promise(() => {}); } });
  const error = await rejected(botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-length": String(TELEGRAM_RESPONSE_LIMIT + 1) }
    })
  }));
  t.ok(cancelCalls === 1 && generic(error), "declared oversized responses settle even when stream cancellation never does");
}

{
  let deadline;
  let cancelCalls = 0;
  let readerReady = false;
  const body = {
    getReader() {
      readerReady = true;
      return {
        read() { return new Promise(() => {}); },
        cancel() { cancelCalls++; return new Promise(() => {}); }
      };
    },
    cancel() { cancelCalls++; return new Promise(() => {}); }
  };
  const pending = botApiRequest("getMe", {}, {
    token: TOKEN,
    fetchImpl: async () => ({ ok: true, body, headers: new Headers() }),
    setTimer(fn, ms) { deadline = { fn, ms }; return 1; },
    clearTimer() {}
  });
  for (let i = 0; i < 12 && (!deadline || !readerReady); i++) await Promise.resolve();
  deadline.fn();
  const error = await rejected(pending);
  t.ok(deadline.ms === TELEGRAM_TIMEOUT_MS && cancelCalls >= 1 && generic(error), "a hanging response body settles even when reader cancellation never does");
}

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.paused = true;
    this.rawModes = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }
  setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
  isPaused() { return this.paused; }
  resume() { this.paused = false; this.resumeCalls++; }
  pause() { this.paused = true; this.pauseCalls++; }
}
class FakeOutput {
  constructor(isTTY = true) { this.isTTY = isTTY; this.text = ""; }
  write(value) { this.text += String(value); return true; }
}

{
  const input = new FakeInput();
  const output = new FakeOutput();
  const reading = readMasked("Credential: ", input, output);
  input.emit("keypress", "a", { name: "a" });
  input.emit("keypress", "b", { name: "b" });
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "c", { name: "c" });
  input.emit("keypress", "\r", { name: "return" });
  const value = await reading;
  t.ok(value === "ac" && output.text === "Credential: **\b \b*\n", "interactive input is masked, supports correction and restores terminal state");
  t.ok(!output.text.includes(value) && JSON.stringify(input.rawModes) === JSON.stringify([true, false]) && input.paused,
    "masked prompt never echoes the credential and restores raw and paused state");
}

{
  const input = new FakeInput();
  const output = new FakeOutput();
  const reading = readMasked("Bounded: ", input, output, 2);
  input.emit("keypress", "a", { name: "a" });
  input.emit("keypress", "b", { name: "b" });
  input.emit("keypress", "c", { name: "c" });
  const error = await rejected(reading);
  t.ok(generic(error) && output.text === "Bounded: **\n" && input.isRaw === false && input.paused,
    "masked input fails closed at its explicit character ceiling and restores the terminal");
}

{
  const input = new FakeInput();
  const output = new FakeOutput();
  const reading = readMasked("Closing: ", input, output, 8);
  input.emit("close");
  input.emit("close");
  input.emit("end");
  const error = await rejected(reading);
  t.ok(generic(error) && JSON.stringify(input.rawModes) === JSON.stringify([true, false]) &&
    input.pauseCalls === 1 && output.text === "Closing: \n", "close performs terminal cleanup exactly once");
}

{
  const input = new FakeInput();
  const output = new FakeOutput();
  const reading = readMasked("Error: ", input, output, 8);
  input.emit("error", new Error(TOKEN + SECRET));
  const error = await rejected(reading);
  t.ok(generic(error) && input.isRaw === false && input.paused && !output.text.includes(TOKEN) && !output.text.includes(SECRET),
    "terminal errors are redacted and restore raw and paused state");
}

{
  let fetchCalls = 0;
  const input = { isTTY: false };
  const output = new FakeOutput(false);
  const errorOutput = new FakeOutput(false);
  const status = await runCli(["discover"], {
    input,
    output,
    errorOutput,
    fetchImpl: async () => { fetchCalls++; throw new Error("must not run"); }
  });
  t.ok(status === 1 && fetchCalls === 0 && /interactive TTY/.test(errorOutput.text), "CLI refuses non-TTY input before reading a credential or making a request");
}

{
  let promptCalls = 0;
  const output = new FakeOutput();
  const errorOutput = new FakeOutput();
  const status = await runCli(["discover", TOKEN], {
    input: { isTTY: true },
    output,
    errorOutput,
    prompt: async () => { promptCalls++; return TOKEN; }
  });
  t.ok(status === 1 && promptCalls === 0 && !errorOutput.text.includes(TOKEN), "credentials in argv are refused without being echoed or prompted for");
}

{
  const input = { isTTY: true };
  const output = new FakeOutput();
  const errorOutput = new FakeOutput();
  const prompts = [];
  const status = await runCli(["set-webhook"], {
    input,
    output,
    errorOutput,
    prompt: async (label, _input, _output, limit) => {
      prompts.push({ label, limit });
      return prompts.length === 1 ? TOKEN : SECRET;
    },
    tokenFetchImpl: activeTokenFetch,
    fetchImpl: async url => response(url.endsWith("/getMe") ? ME : true)
  });
  t.ok(status === 0 && prompts.length === 2 && prompts[0].limit === BOT_TOKEN_INPUT_LIMIT &&
    prompts[1].limit === WEBHOOK_SECRET_INPUT_LIMIT && errorOutput.text === "",
  "set CLI obtains both credentials only through their bounded masked prompts");
  t.ok(!output.text.includes(TOKEN) && !output.text.includes(SECRET) && output.text.includes(PRODUCTION_WEBHOOK_URL), "successful CLI output includes no credential");
}

{
  const input = { isTTY: true };
  const output = new FakeOutput();
  const errorOutput = new FakeOutput();
  const prompts = [];
  const calls = [];
  const status = await runCli(["delete-webhook"], {
    input,
    output,
    errorOutput,
    prompt: async (label, _input, _output, limit) => {
      prompts.push({ label, limit });
      return prompts.length === 1 ? TOKEN : "DELETE";
    },
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith("/getMe")) return response(ME);
      if (url.endsWith("/getWebhookInfo")) return response(webhook(PRODUCTION_WEBHOOK_URL));
      return response(true);
    }
  });
  t.ok(status === 0 && prompts.length === 2 && /confirm/.test(prompts[1].label) &&
    prompts[1].limit === "DELETE".length && calls.some(url => url.endsWith("/deleteWebhook")),
  "delete CLI requires a bounded interactive confirmation before the guarded API operation");
}

{
  let fetchCalls = 0;
  const output = new FakeOutput();
  const errorOutput = new FakeOutput();
  const answers = [TOKEN, "delete"];
  const status = await runCli(["delete-webhook"], {
    input: { isTTY: true },
    output,
    errorOutput,
    prompt: async () => answers.shift(),
    fetchImpl: async () => { fetchCalls++; return response(true); }
  });
  t.ok(status === 1 && fetchCalls === 0 && /redacted/.test(errorOutput.text),
    "an inexact delete confirmation fails before any Bot API request");
}

t.done();
