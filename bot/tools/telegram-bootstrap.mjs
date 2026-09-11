// Production Telegram bootstrap without credentials in argv, environment variables or files.
//
// The CLI accepts one mode and reads every credential from a masked interactive TTY prompt. The exported
// operations take injected fetch/timer functions so their complete HTTP contract is exercised offline.

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TELEGRAM_RESPONSE_LIMIT, TELEGRAM_TIMEOUT_MS } from "../src/telegram.js";

export const EXPECTED_BOT_USERNAME = "lintchabot";
export const DISCOVERY_CHAT = "@lintcha";
export const PRODUCTION_WEBHOOK_URL = "https://chain.lintcha.com/api/telegram";
export const PRODUCTION_ALLOWED_UPDATES = Object.freeze(["message", "edited_message"]);
// This is an implementation safety ceiling, not a claim about BotFather's undocumented exact token length.
export const BOT_TOKEN_INPUT_LIMIT = TELEGRAM_RESPONSE_LIMIT;
export const WEBHOOK_SECRET_INPUT_LIMIT = 256;

const API_ORIGIN = "https://api.telegram.org";
const API_METHODS = new Set(["getMe", "getChat", "getWebhookInfo", "setWebhook", "deleteWebhook"]);
const DEADLINE = Symbol("telegram bootstrap deadline");
const DELETE_CONFIRMATION = "DELETE";

class BootstrapFailure extends Error {
  constructor(code = "failed") {
    super("telegram bootstrap failed");
    this.name = "BootstrapFailure";
    this.code = code;
  }
}

const fail = code => { throw new BootstrapFailure(code); };
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const safeInteger = value => Number.isSafeInteger(value);
const optionalBoolean = value => value === undefined || typeof value === "boolean";
const optionalSafeInteger = value => value === undefined || (safeInteger(value) && value >= 0);

export function validBotToken(value) {
  return typeof value === "string" && value.length <= BOT_TOKEN_INPUT_LIMIT &&
    /^[1-9]\d*:[A-Za-z0-9_-]+$/.test(value);
}

export function validWebhookSecret(value) {
  return typeof value === "string" && value.length <= WEBHOOK_SECRET_INPUT_LIMIT &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

const boundedEnvelope = async (response, limit, deadline, setReader) => {
  if (!response || !response.body || typeof response.body.getReader !== "function") fail("response");
  const declaredRaw = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : null;
  let declared = null;
  if (declaredRaw !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredRaw)) { cancelBestEffort(response.body); fail("response"); }
    declared = Number(declaredRaw);
    if (!safeInteger(declared) || declared > limit) { cancelBestEffort(response.body); fail("response"); }
  }

  let reader;
  try { reader = response.body.getReader(); }
  catch { cancelBestEffort(response.body); fail("response"); }
  setReader(reader);
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === DEADLINE) fail("timeout");
      if (!plainObject(part) || typeof part.done !== "boolean") fail("response");
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0 || part.value.byteLength > limit - size) {
        cancelBestEffort(reader);
        fail("response");
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
  } catch (error) {
    cancelBestEffort(reader);
    throw error;
  } finally {
    setReader(null);
  }
  if (declared !== null && declared !== size) fail("response");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    if (!plainObject(value) || value.ok !== true || !Object.prototype.hasOwnProperty.call(value, "result")) fail("api");
    return value.result;
  } catch (error) {
    if (error instanceof BootstrapFailure) throw error;
    fail("response");
  }
};

/** One strict, deadline-bound Bot API POST. Errors never retain or repeat Telegram's response text. */
export async function botApiRequest(method, params, options = {}) {
  const token = options.token;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs === undefined ? TELEGRAM_TIMEOUT_MS : options.timeoutMs;
  const responseLimit = options.responseLimit === undefined ? TELEGRAM_RESPONSE_LIMIT : options.responseLimit;
  const setTimer = options.setTimer || globalThis.setTimeout;
  const clearTimer = options.clearTimer || globalThis.clearTimeout;
  if (!API_METHODS.has(method) || !plainObject(params) || !validBotToken(token) || typeof fetchImpl !== "function" ||
      !safeInteger(timeoutMs) || timeoutMs < 1 || !safeInteger(responseLimit) || responseLimit < 1 ||
      typeof setTimer !== "function" || typeof clearTimer !== "function") fail("input");

  const controller = new AbortController();
  let reader = null;
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimer(() => {
      try { controller.abort(); } catch {}
      cancelBestEffort(reader);
      resolve(DEADLINE);
    }, timeoutMs);
  });

  try {
    const request = Promise.resolve().then(() => fetchImpl(API_ORIGIN + "/bot" + token + "/" + method, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal
    }));
    const response = await Promise.race([request, deadline]);
    if (response === DEADLINE) fail("timeout");
    if (!response || response.ok !== true) {
      if (response && response.body) cancelBestEffort(response.body);
      fail("api");
    }
    return await boundedEnvelope(response, responseLimit, deadline, value => { reader = value; });
  } catch (error) {
    if (error instanceof BootstrapFailure) throw error;
    fail("request");
  } finally {
    clearTimer(timer);
    reader = null;
  }
}

const requestOptions = options => ({
  token: options.token,
  fetchImpl: options.fetchImpl,
  timeoutMs: options.timeoutMs,
  responseLimit: options.responseLimit,
  setTimer: options.setTimer,
  clearTimer: options.clearTimer
});

const verifiedBot = async request => {
  const me = await botApiRequest("getMe", {}, request);
  if (!plainObject(me) || me.is_bot !== true || !safeInteger(me.id) || me.id <= 0 ||
      typeof me.username !== "string" || me.username.toLowerCase() !== EXPECTED_BOT_USERNAME ||
      !optionalBoolean(me.can_join_groups) || !optionalBoolean(me.can_read_all_group_messages)) fail("identity");
  return {
    username: EXPECTED_BOT_USERNAME,
    can_join_groups: me.can_join_groups === undefined ? null : me.can_join_groups,
    can_read_all_group_messages: me.can_read_all_group_messages === undefined ? null : me.can_read_all_group_messages
  };
};

export async function discoverProductionChat(options = {}) {
  const request = requestOptions(options);
  const bot = await verifiedBot(request);
  const chat = await botApiRequest("getChat", { chat_id: DISCOVERY_CHAT }, request);
  if (!plainObject(chat) || !safeInteger(chat.id) || chat.id === 0 ||
      (chat.type !== "group" && chat.type !== "supergroup") ||
      typeof chat.username !== "string" || ("@" + chat.username.toLowerCase()) !== DISCOVERY_CHAT) fail("identity");
  return {
    bot,
    chat: { query: DISCOVERY_CHAT, id: chat.id, type: chat.type, username: DISCOVERY_CHAT }
  };
}

const webhookInfoOf = value => {
  if (!plainObject(value) || typeof value.url !== "string" || typeof value.has_custom_certificate !== "boolean" ||
      !safeInteger(value.pending_update_count) || value.pending_update_count < 0 ||
      !optionalSafeInteger(value.max_connections) || !optionalSafeInteger(value.last_error_date) ||
      (value.allowed_updates !== undefined && (!Array.isArray(value.allowed_updates) ||
        !value.allowed_updates.every(item => typeof item === "string" && /^[a-z_]{1,64}$/.test(item))))) fail("response");
  return {
    configured: value.url.length > 0,
    matches_production: value.url === PRODUCTION_WEBHOOK_URL,
    has_custom_certificate: value.has_custom_certificate,
    pending_update_count: value.pending_update_count,
    max_connections: value.max_connections === undefined ? null : value.max_connections,
    allowed_updates: value.allowed_updates === undefined ? null : [...value.allowed_updates],
    last_error_date: value.last_error_date === undefined ? null : value.last_error_date,
    has_last_error_message: typeof value.last_error_message === "string" && value.last_error_message.length > 0
  };
};

export async function productionWebhookInfo(options = {}) {
  const request = requestOptions(options);
  await verifiedBot(request);
  return webhookInfoOf(await botApiRequest("getWebhookInfo", {}, request));
}

export async function setProductionWebhook(options = {}) {
  if (!validWebhookSecret(options.secret)) fail("input");
  const request = requestOptions(options);
  await verifiedBot(request);
  const result = await botApiRequest("setWebhook", {
    url: PRODUCTION_WEBHOOK_URL,
    allowed_updates: [...PRODUCTION_ALLOWED_UPDATES],
    drop_pending_updates: false,
    secret_token: options.secret
  }, request);
  if (result !== true) fail("api");
  return { url: PRODUCTION_WEBHOOK_URL, allowed_updates: [...PRODUCTION_ALLOWED_UPDATES], drop_pending_updates: false };
}

export async function deleteProductionWebhook(options = {}) {
  const request = requestOptions(options);
  await verifiedBot(request);
  const current = webhookInfoOf(await botApiRequest("getWebhookInfo", {}, request));
  if (!current.configured) return { deleted: false, drop_pending_updates: false };
  if (!current.matches_production) fail("target");
  const result = await botApiRequest("deleteWebhook", { drop_pending_updates: false }, request);
  if (result !== true) fail("api");
  return { deleted: true, drop_pending_updates: false };
}

/** Masked input for real terminals. No fallback reads from argv, env or a file. */
export async function readMasked(label, input = process.stdin, output = process.stdout, maxChars = BOT_TOKEN_INPUT_LIMIT) {
  if (!input || !output || input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function" ||
      !safeInteger(maxChars) || maxChars < 1) fail("tty");
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
  output.write(label);
  input.setRawMode(true);
  if (typeof input.resume === "function") input.resume();

  return await new Promise((resolve, reject) => {
    const chars = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.removeListener("error", onError);
      try { input.setRawMode(wasRaw); } catch {}
      if (wasPaused && typeof input.pause === "function") input.pause();
      try { output.write("\n"); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new BootstrapFailure("tty"));
    const onClose = () => finish(new BootstrapFailure("tty"));
    const onError = () => finish(new BootstrapFailure("tty"));
    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new BootstrapFailure("cancelled"));
      if (key.name === "return" || key.name === "enter") return finish(null, chars.join(""));
      if (key.name === "backspace" || key.name === "delete") {
        if (chars.length) { chars.pop(); output.write("\b \b"); }
        return;
      }
      if (key.ctrl || key.meta || !str || /[\u0000-\u001f\u007f]/.test(str)) return;
      for (const character of str) {
        if (chars.length >= maxChars) return finish(new BootstrapFailure("input"));
        chars.push(character);
        output.write("*");
      }
    };
    input.on("keypress", onKeypress);
    input.once("end", onEnd);
    input.once("close", onClose);
    input.once("error", onError);
  });
}

const USAGE = "usage: telegram-bootstrap <discover|webhook-info|set-webhook|delete-webhook>";

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const errorOutput = io.errorOutput || process.stderr;
  const prompt = io.prompt || readMasked;
  const fetchImpl = io.fetchImpl || globalThis.fetch;
  if (!Array.isArray(argv) || argv.length !== 1 || !["discover", "webhook-info", "set-webhook", "delete-webhook"].includes(argv[0])) {
    errorOutput.write(USAGE + "\n");
    return 1;
  }
  if (!input || !output || input.isTTY !== true || output.isTTY !== true) {
    errorOutput.write("telegram-bootstrap: an interactive TTY is required\n");
    return 1;
  }

  let token = "";
  let secret = "";
  let confirmation = "";
  try {
    token = await prompt("Bot token: ", input, output, BOT_TOKEN_INPUT_LIMIT);
    let result;
    if (argv[0] === "discover") result = await discoverProductionChat({ token, fetchImpl });
    else if (argv[0] === "webhook-info") result = await productionWebhookInfo({ token, fetchImpl });
    else if (argv[0] === "set-webhook") {
      secret = await prompt("Webhook secret: ", input, output, WEBHOOK_SECRET_INPUT_LIMIT);
      result = await setProductionWebhook({ token, secret, fetchImpl });
    } else {
      confirmation = await prompt("Type DELETE to confirm: ", input, output, DELETE_CONFIRMATION.length);
      if (confirmation !== DELETE_CONFIRMATION) fail("confirmation");
      result = await deleteProductionWebhook({ token, fetchImpl });
    }
    output.write(JSON.stringify({ ok: true, mode: argv[0], ...result }) + "\n");
    return 0;
  } catch {
    errorOutput.write("telegram-bootstrap: failed; response details were redacted\n");
    return 1;
  } finally {
    token = "";
    secret = "";
    confirmation = "";
  }
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) process.exitCode = await runCli();
