import { USER_MODES } from "./stores.mjs";

/**
 * What `/copy` and the namespaced callbacks say. Every reply names the module before any control, never
 * exposes a wallet action in chat, and never lets Telegram confirm a SELL or create a delegation.
 */
export const COPY_TEXTS = Object.freeze({
  HEADER: "Lintcha — copy-trading",
  BOUNDARY: "Copy-trading is an opt-in mode inside Lintcha. Lintcha Core remains read-only.",
  MODE_NOTIFY: "Mode: notifications only. Nothing is signed or submitted in this mode.",
  MODE_CONFIRM: "Mode: confirm each trade. Every BUY and every manual SELL opens the secure sheet for a separate review and wallet confirmation. Auto-SELL is not available.",
  MODE_AUTO: "Mode: auto-copy BUY. Matched BUYs may be submitted only inside your active delegated limits. SELL is always manual.",
  PAUSED: "Status: paused. No review is opened and nothing is submitted while paused.",
  ACTIVE: "Status: active.",
  NEVER_SEED: "Never send a seed phrase or private key in Telegram. Lintcha never asks for one in chat.",
  SELL_TELEGRAM_REFUSED: "SELL was not submitted. Telegram cannot confirm a SELL; review and confirm only inside the Lintcha secure sheet.",
  AUTO_SETUP: "Auto-copy is not active for this wallet yet. Open the secure sheet to review limits and create a bounded, revocable permission. Telegram cannot create it.",
  STALE: "This control is no longer valid. Open /copy again.",
  GLOBAL_PAUSED: "Lintcha copy-trading is paused for everyone right now. Nothing is signed or submitted.",
  REVIEW_BUY: "A source BUY matched your Lintcha rule. Review the fresh simulation and confirm in the secure sheet, or ignore this message. Nothing happens without your wallet confirmation.",
  REVIEW_SELL: "A manual SELL review is ready in Lintcha. Approval and trade are separate confirmations inside the secure sheet. Telegram cannot sign or submit it.",
});

function settingsText(user, globallyPaused) {
  return [
    COPY_TEXTS.HEADER, COPY_TEXTS.BOUNDARY, "",
    user.mode === "AUTO_BUY" ? COPY_TEXTS.MODE_AUTO : user.mode === "CONFIRM_EACH" ? COPY_TEXTS.MODE_CONFIRM : COPY_TEXTS.MODE_NOTIFY,
    globallyPaused ? COPY_TEXTS.GLOBAL_PAUSED : user.paused ? COPY_TEXTS.PAUSED : COPY_TEXTS.ACTIVE,
    "", COPY_TEXTS.NEVER_SEED,
  ].join("\n");
}

export class CopyTelegramSurface {
  constructor({ userStore, delegationStore = null, killSwitches, appOrigin, appPath = "/copy/", service = null, autoBuyAvailable = false }) {
    this.userStore = userStore;
    this.killSwitches = killSwitches;
    this.appUrl = new URL(appPath, appOrigin).toString();
    this.service = service;
    this.delegationStore = delegationStore;
    this.autoBuyAvailable = autoBuyAvailable;
  }

  #settings(user) {
    const paused = Boolean(user.paused);
    return {
      text: settingsText(user, this.killSwitches.globallyPaused),
      inlineKeyboard: [
        [{ text: user.mode === "NOTIFY_ONLY" ? "• Notifications" : "Notifications", callbackData: "copy.mode.notify" }, { text: user.mode === "AUTO_BUY" ? "• Auto-copy BUY" : "Auto-copy BUY", callbackData: "copy.mode.auto_buy" }],
        [{ text: paused ? "Resume" : "Pause", callbackData: paused ? "copy.resume" : "copy.pause" }, { text: "Status", callbackData: "copy.status" }],
        [{ text: "Open Lintcha secure sheet", webAppUrl: this.appUrl }],
      ],
    };
  }

  /** Maps one verified gateway envelope to the constrained response contract. */
  async handle(envelope) {
    const user = await this.userStore.upsert({ telegramUserId: envelope.telegramUserId, privateChatId: envelope.privateChatId });
    if (envelope.referralSource) await this.userStore.recordReferral({ telegramUserId: user.telegramUserId, source: envelope.referralSource });
    if (envelope.route === "COPY_COMMAND") return this.#settings(user);
    const data = envelope.callbackData || "";
    if (data === "copy.mode.notify") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, mode: "NOTIFY_ONLY" }));
    if (data === "copy.mode.confirm_each") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, mode: "CONFIRM_EACH" }));
    if (data === "copy.mode.auto_buy") {
      const wallets = await this.userStore.wallets(user.telegramUserId);
      let ready = false;
      if (this.autoBuyAvailable && this.delegationStore) for (const wallet of wallets) if (await this.delegationStore.getActive(user.telegramUserId, wallet.publicAddress)) { ready = true; break; }
      if (ready) return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, mode: "AUTO_BUY" }));
      const url = new URL(this.appUrl); url.searchParams.set("setup", "auto");
      return { text: `${COPY_TEXTS.HEADER}\n${COPY_TEXTS.AUTO_SETUP}`, inlineKeyboard: [[{ text: "Set up auto-copy safely", webAppUrl: url.toString() }]] };
    }
    if (data === "copy.pause") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, paused: true }));
    if (data === "copy.resume") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, paused: false }));
    if (data === "copy.status") return this.#settings(user);
    if (data.startsWith("sell.confirm.")) return { text: `${COPY_TEXTS.HEADER}\n${COPY_TEXTS.SELL_TELEGRAM_REFUSED}` };
    if (data === "sell.cancel" || data === "trade.cancel") return { text: `${COPY_TEXTS.HEADER}\nCancelled. No transaction was submitted.` };
    const review = /^(trade|sell)\.review\.([0-9a-f]{64})$/.exec(data);
    if (review) {
      const intentId = review[2];
      if (this.service) {
        try {
          const view = await this.service.getIntentForUser({ intentId, userId: user.telegramUserId });
          if (view.state !== "AWAITING_USER_CONFIRMATION") return { text: `${COPY_TEXTS.HEADER}\nThis review is closed (${view.state}). Nothing was submitted from Telegram.` };
        } catch { return { text: `${COPY_TEXTS.HEADER}\n${COPY_TEXTS.STALE}` }; }
      }
      return this.reviewMessage({ intentId, direction: review[1] === "sell" ? "SELL" : "BUY" });
    }
    return { text: `${COPY_TEXTS.HEADER}\n${COPY_TEXTS.STALE}` };
  }

  /** The proactive line Core delivers from the outbox when a new intent awaits the user. */
  reviewMessage({ intentId, direction }) {
    const url = new URL(this.appUrl);
    url.searchParams.set("intent", intentId);
    return {
      text: `${COPY_TEXTS.HEADER}\n${direction === "SELL" ? COPY_TEXTS.REVIEW_SELL : COPY_TEXTS.REVIEW_BUY}`,
      inlineKeyboard: [[{ text: direction === "SELL" ? "Review SELL in Lintcha" : "Review BUY in Lintcha", webAppUrl: url.toString() }], [{ text: "Ignore", callbackData: `${direction === "SELL" ? "sell" : "trade"}.cancel` }]],
    };
  }
}

export { USER_MODES };
