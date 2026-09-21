import { normalizeAddress } from "../utils.mjs";

function secureStorageSupported(webApp) {
  const storage = webApp?.SecureStorage;
  return storage && ["setItem", "getItem", "removeItem"].every((method) => typeof storage[method] === "function");
}

function biometricSupported(webApp) {
  const biometric = webApp?.BiometricManager;
  return biometric
    && biometric.isInited === true
    && biometric.isBiometricAvailable === true
    && biometric.isAccessGranted === true
    && typeof biometric.authenticate === "function";
}

export function secureSheetCapabilities(webApp) {
  return Object.freeze({ secureStorage: Boolean(secureStorageSupported(webApp)), biometric: Boolean(biometricSupported(webApp)) });
}

function biometricInit(biometric) {
  return new Promise((resolve, reject) => {
    if (typeof biometric?.init !== "function") return reject(new Error("BIOMETRIC_INIT_UNAVAILABLE"));
    biometric.init(() => resolve());
  });
}

function requestBiometricAccess(biometric, reason) {
  return new Promise((resolve, reject) => {
    if (typeof biometric?.requestAccess !== "function") return reject(new Error("BIOMETRIC_ACCESS_UNAVAILABLE"));
    biometric.requestAccess({ reason }, (granted) => granted ? resolve() : reject(new Error("BIOMETRIC_ACCESS_DENIED")));
  });
}

export async function prepareSecureSheet(webApp, reason = "Protect local wallet") {
  if (!secureStorageSupported(webApp)) return secureSheetCapabilities(webApp);
  const biometric = webApp?.BiometricManager;
  if (!biometric) return secureSheetCapabilities(webApp);
  try {
    if (biometric.isInited !== true) await biometricInit(biometric);
    if (biometric.isBiometricAvailable !== true) return secureSheetCapabilities(webApp);
    if (biometric.isAccessGranted !== true) await requestBiometricAccess(biometric, reason);
  } catch {
    return secureSheetCapabilities(webApp);
  }
  return secureSheetCapabilities(webApp);
}

function storageCall(storage, method, ...args) {
  return new Promise((resolve, reject) => {
    storage[method](...args, (error, value) => error ? reject(new Error(String(error))) : resolve(value));
  });
}

function authenticate(biometric, reason) {
  return new Promise((resolve, reject) => {
    biometric.authenticate({ reason }, (success, token) => success ? resolve(token) : reject(new Error("BIOMETRIC_AUTH_FAILED")));
  });
}

function clearAccount(account) {
  if (!account || typeof account !== "object") return;
  account.vaultRecord = null;
  account.recoveryView = null;
}

export class SecureSheetController {
  constructor({ webApp, walletProvider, registerPublicAddress, localDisplay, closeSheet }) {
    this.webApp = webApp;
    this.walletProvider = walletProvider;
    this.registerPublicAddress = registerPublicAddress;
    this.localDisplay = localDisplay;
    this.closeSheet = closeSheet;
  }

  async createLocalWallet(alias) {
    const capabilities = await prepareSecureSheet(this.webApp, "Protect local wallet");
    if (!capabilities.secureStorage || !capabilities.biometric) return { ok: false, reason: "SECURE_CAPABILITY_UNAVAILABLE", fallback: "external_wallet" };
    if (typeof this.walletProvider?.generateAccount !== "function") return { ok: false, reason: "AUDITED_WALLET_PROVIDER_UNAVAILABLE", fallback: "external_wallet" };
    await authenticate(this.webApp.BiometricManager, "Create local wallet");
    const account = await this.walletProvider.generateAccount();
    let challenge;
    try {
      if (typeof this.walletProvider?.createBackupChallenge !== "function") {
        return { ok: false, reason: "BACKUP_CONFIRMATION_UNAVAILABLE" };
      }
      challenge = await this.walletProvider.createBackupChallenge(account.recoveryView);
      const response = await this.localDisplay({
        kind: "recovery_backup",
        value: account.recoveryView,
        positions: challenge.positions,
      });
      if (!challenge.verify(response?.words)) {
        return { ok: false, reason: "BACKUP_CONFIRMATION_FAILED" };
      }
      return await this.#persistAndRegister(account, alias);
    } finally {
      challenge?.destroy?.();
      clearAccount(account);
      await this.localDisplay({ kind: "clear_sensitive" });
    }
  }

  async importLocalWallet(importMaterial, alias) {
    const capabilities = await prepareSecureSheet(this.webApp, "Protect imported wallet");
    if (!capabilities.secureStorage || !capabilities.biometric) return { ok: false, reason: "SECURE_CAPABILITY_UNAVAILABLE", fallback: "external_wallet" };
    if (typeof this.walletProvider?.importAccount !== "function") return { ok: false, reason: "AUDITED_WALLET_PROVIDER_UNAVAILABLE", fallback: "external_wallet" };
    await authenticate(this.webApp.BiometricManager, "Import local wallet");
    let account;
    try {
      account = await this.walletProvider.importAccount(importMaterial);
      importMaterial = null;
      return await this.#persistAndRegister(account, alias);
    } finally {
      importMaterial = null;
      clearAccount(account);
      await this.localDisplay({ kind: "clear_sensitive" });
    }
  }

  async revealRecovery(storageKey) {
    const capabilities = await prepareSecureSheet(this.webApp, "Unlock wallet recovery");
    if (!capabilities.secureStorage || !capabilities.biometric) throw new Error("SECURE_CAPABILITY_UNAVAILABLE");
    await authenticate(this.webApp.BiometricManager, "Unlock wallet recovery");
    let vaultRecord;
    let recoveryView;
    try {
      vaultRecord = await storageCall(this.webApp.SecureStorage, "getItem", storageKey);
      if (vaultRecord === null) throw new Error("WALLET_VAULT_NOT_FOUND");
      recoveryView = await this.walletProvider.recoveryView(vaultRecord);
      await this.localDisplay({ kind: "recovery", value: recoveryView });
      return { shownLocally: true };
    } finally {
      vaultRecord = null;
      recoveryView = null;
      await this.localDisplay({ kind: "clear_sensitive" });
    }
  }

  async #persistAndRegister(account, alias) {
    const publicAddress = normalizeAddress(account.publicAddress);
    const storageKey = `wallet_${publicAddress.slice(2)}`;
    await storageCall(this.webApp.SecureStorage, "setItem", storageKey, account.vaultRecord);
    await this.registerPublicAddress({ publicAddress, alias, mode: "local" });
    await this.closeSheet();
    return { ok: true, publicAddress, storageKey };
  }
}

export async function connectExternalWallet(connector, registerPublicAddress, alias) {
  const result = await connector.connect();
  const publicAddress = normalizeAddress(result.publicAddress);
  await registerPublicAddress({ publicAddress, alias, mode: "external" });
  return { publicAddress, chainId: result.chainId };
}
