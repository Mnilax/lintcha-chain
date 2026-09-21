import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ETHEREUM_DERIVATION_PATH,
  SecureSheetWalletProvider,
} from "../src/wallet-provider.mjs";

function fixtureCrypto(fillByte = 0x2a) {
  let calls = 0;
  return {
    get calls() { return calls; },
    getRandomValues(array) {
      calls += 1;
      for (let index = 0; index < array.length; index += 1) {
        array[index] = array instanceof Uint32Array ? calls - 1 : fillByte;
      }
      return array;
    },
  };
}

test("secure provider derives a stable EVM address from browser CSPRNG entropy", async () => {
  const cryptoProvider = fixtureCrypto();
  const provider = new SecureSheetWalletProvider({ cryptoProvider });
  const first = await provider.generateAccount();
  const second = await provider.generateAccount();
  assert.match(first.publicAddress, /^0x[0-9a-f]{40}$/);
  assert.equal(first.publicAddress, second.publicAddress);
  assert.match(first.vaultRecord, new RegExp(ETHEREUM_DERIVATION_PATH.replaceAll("'", "\\'")));
  assert.ok(cryptoProvider.calls >= 2);
});

test("secure provider round-trips only through its local vault boundary", async () => {
  const provider = new SecureSheetWalletProvider({ cryptoProvider: fixtureCrypto(0x19) });
  const created = await provider.generateAccount();
  const restoredView = await provider.recoveryView(created.vaultRecord);
  const imported = await provider.importAccount(restoredView);
  assert.equal(imported.publicAddress, created.publicAddress);
  assert.equal(imported.recoveryView, restoredView);
  assert.rejects(() => provider.importAccount("TEST FIXTURE INVALID RECOVERY"), /INVALID_RECOVERY_PHRASE/);
});

test("backup challenge checks random word positions locally and can be destroyed", async () => {
  const provider = new SecureSheetWalletProvider({ cryptoProvider: fixtureCrypto(0x55) });
  const account = await provider.generateAccount();
  const challenge = await provider.createBackupChallenge(account.recoveryView, 3);
  const words = account.recoveryView.split(" ");
  const answers = challenge.positions.map((position) => words[position - 1]);
  assert.equal(challenge.verify(answers), true);
  assert.equal(challenge.verify(answers.map(() => "incorrect")), false);
  challenge.destroy();
  assert.equal(challenge.verify(answers), false);
});

test("provider module has no network, logging, browser persistence or Node crypto escape hatch", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/wallet-provider.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|CloudStorage/);
  assert.doesNotMatch(source, /console\.|node:crypto|createPrivateKey|createSecretKey/);
});

test("provider fails closed without browser crypto.getRandomValues", () => {
  assert.throws(() => new SecureSheetWalletProvider({ cryptoProvider: {} }), /BROWSER_CSPRNG_UNAVAILABLE/);
});
