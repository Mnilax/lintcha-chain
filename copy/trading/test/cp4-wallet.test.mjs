import assert from "node:assert/strict";
import { test } from "node:test";
import { CallbackGuard } from "../src/wallet/callbacks.mjs";
import { walletCard } from "../src/wallet/cards.mjs";
import { prepareSecureSheet, SecureSheetController, secureSheetCapabilities } from "../src/wallet/secure-sheet.mjs";
import { signTelegramInitData, validateTelegramInitData } from "../src/wallet/telegram-auth.mjs";

function makeInitData(fields, token) {
  const hash = signTelegramInitData(fields, token);
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("CP4: Telegram initData validates HMAC and freshness", () => {
  const botToken = "TEST_FIXTURE_BOT_TOKEN_NOT_REAL";
  const fields = { auth_date: "1000", query_id: "fixture-query", user: JSON.stringify({ id: 12345, first_name: "Fixture" }) };
  const result = validateTelegramInitData(makeInitData(fields, botToken), { botToken, nowSeconds: 1050, maxAgeSeconds: 300, maxFutureSkewSeconds: 5 });
  assert.equal(result.telegramUserId, "12345");
  assert.throws(() => validateTelegramInitData(makeInitData(fields, botToken), { botToken, nowSeconds: 1400, maxAgeSeconds: 300, maxFutureSkewSeconds: 5 }), /STALE_INIT_DATA/);
  assert.throws(() => validateTelegramInitData(makeInitData(fields, botToken).replace("Fixture", "Changed"), { botToken, nowSeconds: 1050, maxAgeSeconds: 300, maxFutureSkewSeconds: 5 }), /INVALID_INIT_DATA_HASH/);
});

test("CP4: callback guard enforces owner, revision, freshness and replay", () => {
  const guard = new CallbackGuard({ signingSecret: "TEST_CALLBACK_SECRET_NOT_REAL", maxAgeSeconds: 60 });
  const token = guard.issue({ userId: "1", subjectId: "wallet-1", action: "delete", revision: 3, issuedAt: 1000, nonce: "fixture-nonce" });
  assert.ok(token.length <= 64);
  assert.throws(() => guard.consume(token, { telegramUserId: "2", currentRevision: 3, nowSeconds: 1010 }), /OWNER_MISMATCH/);
  assert.throws(() => guard.consume(token, { telegramUserId: "1", currentRevision: 2, nowSeconds: 1010 }), /STALE_CALLBACK_REVISION/);
  assert.deepEqual(guard.consume(token, { telegramUserId: "1", currentRevision: 3, nowSeconds: 1010 }), { subjectId: "wallet-1", action: "delete", revision: 3 });
  assert.throws(() => guard.consume(token, { telegramUserId: "1", currentRevision: 3, nowSeconds: 1010 }), /CALLBACK_REPLAY/);
});

function fakeWebApp(storageMap) {
  return {
    SecureStorage: {
      setItem(key, value, callback) { storageMap.set(key, value); callback(null, true); },
      getItem(key, callback) { callback(null, storageMap.get(key) ?? null, false); },
      removeItem(key, callback) { callback(null, storageMap.delete(key)); },
    },
    BiometricManager: {
      isInited: true,
      isBiometricAvailable: true,
      isAccessGranted: true,
      authenticate(_params, callback) { callback(true, "TEST_BIOMETRIC_TOKEN_NOT_REAL"); },
    },
  };
}

test("CP4: secure sheet keeps fixture-sensitive material out of server-visible channels", async () => {
  const storage = new Map();
  const fixtureSensitive = ["fixture", "sensitive", "material", "never", "reaches", "server"].join(" ");
  const observed = { network: [], logs: [], database: [], urls: [], botMessages: [] };
  let closed = false;
  let recoveryWasShown = false;
  let sensitiveCleared = false;
  const controller = new SecureSheetController({
    webApp: fakeWebApp(storage),
    walletProvider: {
      async generateAccount() {
        return { publicAddress: "0x3333333333333333333333333333333333333333", vaultRecord: fixtureSensitive, recoveryView: fixtureSensitive };
      },
      async createBackupChallenge(recoveryView) {
        const words = recoveryView.split(" ");
        const positions = [1, 3, 6];
        return { positions, verify: (answers) => JSON.stringify(answers) === JSON.stringify(positions.map((position) => words[position - 1])), destroy() { words.fill(""); } };
      },
      async recoveryView(record) { return record; },
    },
    async registerPublicAddress(body) { observed.network.push(body); observed.database.push(body); },
    async localDisplay(view) {
      if (view.kind === "recovery_backup") {
        recoveryWasShown = view.value === fixtureSensitive;
        const words = view.value.split(" ");
        return { words: view.positions.map((position) => words[position - 1]) };
      }
      if (view.kind === "clear_sensitive") sensitiveCleared = true;
      return undefined;
    },
    async closeSheet() { closed = true; },
  });
  const result = await controller.createLocalWallet("Fixture wallet");
  assert.equal(result.ok, true);
  assert.equal(closed, true);
  assert.equal(recoveryWasShown, true);
  assert.equal(sensitiveCleared, true);
  assert.equal(storage.get(result.storageKey), fixtureSensitive);
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(fixtureSensitive));
  assert.match(JSON.stringify(observed.network), /3333333333333333333333333333333333333333/);
});

test("CP4: unsupported secure client blocks local wallet before generation", async () => {
  let generated = false;
  const controller = new SecureSheetController({
    webApp: {},
    walletProvider: { async generateAccount() { generated = true; } },
    registerPublicAddress() {}, localDisplay() {}, closeSheet() {},
  });
  const result = await controller.createLocalWallet("Blocked");
  assert.equal(result.reason, "SECURE_CAPABILITY_UNAVAILABLE");
  assert.equal(generated, false);
  assert.deepEqual(secureSheetCapabilities({}), { secureStorage: false, biometric: false });
});

test("CP4: biometric permission and backup confirmation fail closed", async () => {
  let generated = false;
  const deniedWebApp = fakeWebApp(new Map());
  deniedWebApp.BiometricManager.isAccessGranted = false;
  deniedWebApp.BiometricManager.requestAccess = (_params, callback) => callback(false);
  const denied = new SecureSheetController({
    webApp: deniedWebApp,
    walletProvider: { async generateAccount() { generated = true; } },
    registerPublicAddress() {}, localDisplay() {}, closeSheet() {},
  });
  assert.equal((await denied.createLocalWallet("Denied")).reason, "SECURE_CAPABILITY_UNAVAILABLE");
  assert.equal(generated, false);

  const storage = new Map();
  let registered = false;
  const unconfirmed = new SecureSheetController({
    webApp: fakeWebApp(storage),
    walletProvider: {
      async generateAccount() { return { publicAddress: "0x5555555555555555555555555555555555555555", vaultRecord: "fixture secret", recoveryView: "fixture secret" }; },
      async createBackupChallenge() { return { positions: [1, 2], verify() { return false; }, destroy() {} }; },
    },
    async registerPublicAddress() { registered = true; },
    async localDisplay() { return { words: ["wrong", "answer"] }; },
    async closeSheet() {},
  });
  assert.equal((await unconfirmed.createLocalWallet("Unconfirmed")).reason, "BACKUP_CONFIRMATION_FAILED");
  assert.equal(registered, false);
  assert.equal(storage.size, 0);
});

test("CP4: secure sheet initializes biometrics and requests access before use", async () => {
  const storage = new Map();
  const webApp = fakeWebApp(storage);
  webApp.BiometricManager.isInited = false;
  webApp.BiometricManager.isAccessGranted = false;
  webApp.BiometricManager.init = (callback) => { webApp.BiometricManager.isInited = true; callback(); };
  webApp.BiometricManager.requestAccess = (_params, callback) => { webApp.BiometricManager.isAccessGranted = true; callback(true); };
  assert.deepEqual(await prepareSecureSheet(webApp), { secureStorage: true, biometric: true });
});

test("CP4: wallet card contains only public data and secure-sheet recovery link", () => {
  const guard = new CallbackGuard({ signingSecret: "TEST_CALLBACK_SECRET_NOT_REAL", maxAgeSeconds: 60 });
  let nonce = 0;
  const card = walletCard({ id: "w1", publicAddress: "0x4444444444444444444444444444444444444444", alias: "Main", revision: 2, balance: "1.0" }, {
    secureSheetBaseUrl: "https://local.invalid/secure",
    callbackFor(action) { nonce += 1; return guard.issue({ userId: "1", subjectId: "w1", action, revision: 2, issuedAt: 1000, nonce: `n-${nonce}` }); },
  });
  assert.match(card.text, /0x4444/);
  assert.match(JSON.stringify(card.reply_markup), /action=recovery/);
  assert.doesNotMatch(JSON.stringify(card), /seed|mnemonic|private key/i);
});
