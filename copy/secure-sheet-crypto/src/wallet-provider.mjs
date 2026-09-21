import { HDKey } from "@scure/bip32";
import {
  entropyToMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const ETHEREUM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const VAULT_SCHEMA = "lintcha.secure-wallet.v1";
const MNEMONIC_MAX_LENGTH = 512;

function assertCryptoProvider(cryptoProvider) {
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== "function") {
    throw new Error("BROWSER_CSPRNG_UNAVAILABLE");
  }
}

function secureEntropy(cryptoProvider) {
  assertCryptoProvider(cryptoProvider);
  const entropy = new Uint8Array(16);
  cryptoProvider.getRandomValues(entropy);
  return entropy;
}

function normalizeMnemonic(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MNEMONIC_MAX_LENGTH) {
    throw new Error("INVALID_RECOVERY_PHRASE");
  }
  const mnemonic = value.normalize("NFKD").trim().split(/\s+/u).join(" ");
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("INVALID_RECOVERY_PHRASE");
  return mnemonic;
}

function evmAddressFromPrivateKey(privateKey) {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const digest = keccak_256(publicKey.subarray(1));
  return `0x${bytesToHex(digest.subarray(digest.length - 20))}`;
}

function deriveAccount(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  let root;
  let child;
  let privateKey;
  try {
    root = HDKey.fromMasterSeed(seed);
    child = root.derive(ETHEREUM_DERIVATION_PATH);
    privateKey = child.privateKey;
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
      throw new Error("PRIVATE_KEY_DERIVATION_FAILED");
    }
    return { publicAddress: evmAddressFromPrivateKey(privateKey) };
  } finally {
    privateKey?.fill(0);
    child?.wipePrivateData();
    root?.wipePrivateData();
    seed.fill(0);
  }
}

function encodeVault(mnemonic) {
  return JSON.stringify({ schema: VAULT_SCHEMA, mnemonic, path: ETHEREUM_DERIVATION_PATH });
}

function decodeVault(vaultRecord) {
  if (typeof vaultRecord !== "string" || vaultRecord.length === 0 || vaultRecord.length > 1024) {
    throw new Error("INVALID_VAULT_RECORD");
  }
  let decoded;
  try {
    decoded = JSON.parse(vaultRecord);
  } catch {
    throw new Error("INVALID_VAULT_RECORD");
  }
  if (decoded?.schema !== VAULT_SCHEMA || decoded?.path !== ETHEREUM_DERIVATION_PATH) {
    throw new Error("INVALID_VAULT_RECORD");
  }
  return normalizeMnemonic(decoded.mnemonic);
}

function accountEnvelope(mnemonic) {
  const { publicAddress } = deriveAccount(mnemonic);
  return {
    publicAddress,
    vaultRecord: encodeVault(mnemonic),
    recoveryView: mnemonic,
  };
}

function randomIndex(cryptoProvider, upperExclusive) {
  assertCryptoProvider(cryptoProvider);
  const rejectionLimit = Math.floor(0x1_0000_0000 / upperExclusive) * upperExclusive;
  const sample = new Uint32Array(1);
  do cryptoProvider.getRandomValues(sample); while (sample[0] >= rejectionLimit);
  return sample[0] % upperExclusive;
}

export class SecureSheetWalletProvider {
  constructor({ cryptoProvider = globalThis.crypto } = {}) {
    assertCryptoProvider(cryptoProvider);
    this.cryptoProvider = cryptoProvider;
  }

  async generateAccount() {
    const entropy = secureEntropy(this.cryptoProvider);
    try {
      return accountEnvelope(entropyToMnemonic(entropy, wordlist));
    } finally {
      entropy.fill(0);
    }
  }

  async importAccount(importMaterial) {
    return accountEnvelope(normalizeMnemonic(importMaterial));
  }

  async recoveryView(vaultRecord) {
    return decodeVault(vaultRecord);
  }

  async createBackupChallenge(recoveryView, count = 3) {
    const mnemonic = normalizeMnemonic(recoveryView);
    const words = mnemonic.split(" ");
    if (!Number.isSafeInteger(count) || count < 2 || count > Math.min(4, words.length)) {
      throw new Error("INVALID_BACKUP_CHALLENGE_SIZE");
    }
    const positions = new Set();
    while (positions.size < count) positions.add(randomIndex(this.cryptoProvider, words.length));
    const ordered = [...positions].sort((left, right) => left - right);
    const expected = ordered.map((position) => words[position]);
    return {
      positions: Object.freeze(ordered.map((position) => position + 1)),
      verify(answers) {
        if (!Array.isArray(answers) || answers.length !== expected.length) return false;
        return answers.every((answer, index) => String(answer ?? "").normalize("NFKD").trim() === expected[index]);
      },
      destroy() {
        expected.fill("");
        words.fill("");
      },
    };
  }
}
