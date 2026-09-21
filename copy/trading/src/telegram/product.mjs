import { deterministicId, normalizeAddress } from "../utils.mjs";
import { TRADING_MODES } from "../execution/authorization.mjs";

const PRIVATE_COMMANDS = new Set(["/copy", "/watch", "/rules", "/positions", "/history", "/pause", "/resume", "/wallet", "/ref"]);

function safeLabel(value, fallback) {
  const text = String(value ?? fallback).replace(/[<>\u0000-\u001f]/g, "").trim();
  return (text || fallback).slice(0, 64);
}

function shortAddress(value) {
  const address = normalizeAddress(value);
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function walletListMessage(wallets) {
  const lines = ["Tracked public wallets"];
  for (const wallet of wallets) lines.push(`• ${safeLabel(wallet.alias, "Wallet")} — ${shortAddress(wallet.publicAddress)} — ${wallet.balance ?? "—"}`);
  if (wallets.length === 0) lines.push("No wallets registered.");
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[{ text: "Add public address", callback_data: "wallet.add_public" }]] } };
}

export function targetListMessage(targets) {
  return { text: ["Watched wallets", ...targets.map((target) => `• ${safeLabel(target.alias, "Target")} — ${shortAddress(target.sourceAddress)} — ${target.status}`)].join("\n") };
}

export function ruleListMessage(rules) {
  return { text: ["Copy rules", ...rules.map((rule) => `• ${rule.id}: ${rule.direction}, ${rule.sizingPolicy}, ${rule.status}`)].join("\n") };
}

export function tradeReceiptMessage(order) {
  const label = order.state === "CONFIRMED" ? "Transaction confirmed" : `Transaction ${order.state.toLowerCase()}`;
  return { text: [label, `Direction: ${order.quote.direction}`, `Token: ${shortAddress(order.quote.targetToken)}`, `Amount: ${order.quote.amountIn}`, `Minimum received: ${order.quote.minimumOutput}`, `State: ${order.state}`].join("\n") };
}

export class TelegramProduct {
  constructor({ botUsername, dataSource, intentSink, manualSellService = null, copyAppUrl = null }) {
    this.botUsername = botUsername;
    this.dataSource = dataSource;
    this.intentSink = intentSink;
    this.manualSellService = manualSellService;
    this.copyAppUrl = copyAppUrl;
    this.processedUpdates = new Map();
  }

  async handle(update) {
    if (this.processedUpdates.has(update.updateId)) return { ...this.processedUpdates.get(update.updateId), duplicate: true };
    const command = String(update.command ?? "").split(/\s+/, 1)[0].toLowerCase();
    let response;
    if (update.chatType !== "private") {
      response = PRIVATE_COMMANDS.has(command)
        ? { text: `This action is available only in a private chat with @${this.botUsername}.`, privateBoundary: true }
        : { text: `Open @${this.botUsername} in a private chat.`, privateBoundary: true };
    } else {
      response = update.kind === "callback"
        ? await this.#privateCallback(String(update.callbackData ?? ""), update)
        : await this.#privateCommand(command, update);
    }
    const stable = { ...response, duplicate: false };
    this.processedUpdates.set(update.updateId, stable);
    return stable;
  }

  async #privateCommand(command, update) {
    const userId = String(update.userId);
    if (command === "/wallet") return walletListMessage(await this.dataSource.wallets(userId));
    if (command === "/watch") return targetListMessage(await this.dataSource.targets(userId));
    if (command === "/rules") return ruleListMessage(await this.dataSource.rules(userId));
    if (command === "/positions") return { text: ["Positions", ...(await this.dataSource.positions(userId))].join("\n") };
    if (command === "/history") return { text: ["History", ...(await this.dataSource.history(userId))].join("\n") };
    if (command === "/pause" || command === "/resume") {
      const paused = command === "/pause";
      await this.dataSource.setPause(userId, paused);
      return { text: paused ? "Copy notifications paused." : "Copy notifications resumed after review." };
    }
    if (command === "/copy") {
      const profile = await this.#tradingProfile(userId);
      const intentId = deterministicId("review", update.updateId, userId);
      await this.intentSink.create({ id: intentId, userId, kind: "copy_settings_open", source: "telegram" });
      return {
        text: [
          "Copy-trading settings",
          "Mode: Lintcha — copy-trading (internally isolated from read-only Lintcha Core)",
          `Current mode: ${profile.mode === TRADING_MODES.CONFIRM_EACH ? "confirm every trade" : "notifications only"}`,
          profile.mode === TRADING_MODES.CONFIRM_EACH
            ? "Every BUY and SELL opens the secure sheet for a separate review and wallet confirmation."
            : "No transaction is signed or submitted in this mode.",
        ].join("\n"),
        reply_markup: { inline_keyboard: [[
          { text: "🔔 Notifications", callback_data: "copy.mode.notify" },
          { text: "✅ Confirm each trade", callback_data: "copy.mode.confirm_each" },
        ], [
          { text: "Watched wallets", callback_data: "copy.targets" },
          { text: "Rules", callback_data: "copy.rules" },
        ], [{ text: "Pause", callback_data: "copy.pause" }]] },
        intentId,
      };
    }
    if (command === "/ref") return { text: "Referral attribution and accrued rewards are shown without wallet secrets.", reply_markup: { inline_keyboard: [[{ text: "Referral details", callback_data: "ref.details" }]] } };
    return { text: "Commands: /wallet /watch /rules /positions /history /pause /resume /copy /ref" };
  }

  async #privateCallback(data, update) {
    const userId = String(update.userId);
    if (data.startsWith("sell.review.")) {
      if (!this.copyAppUrl) return { text: "Manual SELL is unavailable until the isolated Lintcha secure sheet is configured.", executionBlocked: true };
      const url = new URL(this.copyAppUrl);
      url.searchParams.set("intent", data.slice("sell.review.".length));
      return {
        text: "Lintcha manual SELL requires a fresh simulation, local review, and a separate confirmation inside the secure sheet. Telegram cannot sign or submit it.",
        reply_markup: { inline_keyboard: [[{ text: "Review SELL in Lintcha", web_app: { url: url.toString() } }]] },
      };
    }
    if (data.startsWith("sell.confirm.")) {
      return { text: "SELL was not submitted. Telegram confirmations are disabled; confirm only inside the Lintcha secure sheet.", executionBlocked: true };
    }
    if (data === "sell.cancel") return { text: "SELL cancelled. No transaction was submitted." };
    if (data === "copy.mode.notify") {
      await this.dataSource.setTradingMode(userId, TRADING_MODES.NOTIFY_ONLY);
      return { text: "Mode changed: notifications only. Automatic signing and submission are disabled." };
    }
    if (data === "copy.mode.confirm_each") {
      await this.dataSource.setTradingMode(userId, TRADING_MODES.CONFIRM_EACH);
      return { text: "Mode changed: confirm every trade. BUY and SELL both require a fresh simulation and an explicit wallet confirmation inside the Lintcha secure sheet. Auto-SELL is disabled." };
    }
    if (data === "copy.mode.auto.review") {
      return { text: "Auto-BUY remains globally paused until bounded delegation, revoke, two-provider simulation and dust-wallet acceptance pass. Notifications and confirm-each remain available locally; auto-SELL is disabled.", executionBlocked: true };
    }
    if (data === "copy.mode.auto.enable") {
      return { text: "Auto-copy remains disabled and cannot be enabled from Telegram.", executionBlocked: true };
    }
    if (data === "copy.targets") return targetListMessage(await this.dataSource.targets(userId));
    if (data === "copy.rules") return ruleListMessage(await this.dataSource.rules(userId));
    if (data === "copy.pause") {
      await this.dataSource.setPause(userId, true);
      return { text: "Copy-trading and notifications paused." };
    }
    return { text: "This control is no longer valid. Open /copy again." };
  }

  async #tradingProfile(userId) {
    if (typeof this.dataSource.tradingProfile !== "function") {
      return { mode: TRADING_MODES.NOTIFY_ONLY, authorizationStatus: "missing" };
    }
    return this.dataSource.tradingProfile(userId);
  }
}
