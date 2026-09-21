import assert from "node:assert/strict";
import { test } from "node:test";
import { SecureSheetController } from "../../trading/src/wallet/secure-sheet.mjs";
import { SecureSheetWalletProvider } from "../src/wallet-provider.mjs";

function deterministicCrypto() {
  let counter = 1;
  return {
    getRandomValues(array) {
      if (array instanceof Uint32Array) {
        array[0] = counter;
        counter += 1;
      } else {
        array.fill(0x37);
      }
      return array;
    },
  };
}

function secureTelegramFixture(storage) {
  return {
    SecureStorage: {
      setItem(key, value, callback) { storage.set(key, value); callback(null, true); },
      getItem(key, callback) { callback(null, storage.get(key) ?? null, false); },
      removeItem(key, callback) { callback(null, storage.delete(key)); },
    },
    BiometricManager: {
      isInited: true,
      isBiometricAvailable: true,
      isAccessGranted: true,
      authenticate(_params, callback) { callback(true, "TEST_ONLY_BIOMETRIC_TOKEN"); },
    },
  };
}

test("real provider crosses secure-sheet boundary with public address only", async () => {
  const storage = new Map();
  const serverVisible = [];
  let displayedRecovery;
  let closed = false;
  const controller = new SecureSheetController({
    webApp: secureTelegramFixture(storage),
    walletProvider: new SecureSheetWalletProvider({ cryptoProvider: deterministicCrypto() }),
    async registerPublicAddress(body) { serverVisible.push(structuredClone(body)); },
    async localDisplay(view) {
      if (view.kind === "recovery_backup") {
        displayedRecovery = view.value;
        const words = view.value.split(" ");
        return { words: view.positions.map((position) => words[position - 1]) };
      }
      if (view.kind === "clear_sensitive") displayedRecovery = undefined;
      return undefined;
    },
    async closeSheet() { closed = true; },
  });

  const result = await controller.createLocalWallet("Fixture local wallet");
  assert.equal(result.ok, true);
  assert.equal(closed, true);
  assert.equal(displayedRecovery, undefined);
  assert.equal(storage.size, 1);
  assert.deepEqual(serverVisible, [{ publicAddress: result.publicAddress, alias: "Fixture local wallet", mode: "local" }]);
  assert.doesNotMatch(JSON.stringify(serverVisible), /mnemonic|private|vault|recovery/i);
});
