import { USER_MODES } from "./stores.mjs";

/**
 * What `/copy` and the namespaced callbacks say. Every reply names the module before any control, never
 * exposes a wallet action in chat, and never lets Telegram confirm a SELL or enable auto-copy.
 */
export const COPY_TEXTS = Object.freeze({
  HEADER: "Lintcha Copy — trading",
  BOUNDARY: "This is Lintcha Copy, a separate voluntary trading module. It is not read-only Lintcha Core.",
  MODE_NOTIFY: "Mode: notifications only. Nothing is signed or submitted in this mode.",
  MODE_CONFIRM: "Mode: confirm each trade. Every BUY and every manual SELL opens the secure sheet for a separate review and wallet confirmation. Auto-SELL is not available.",
  PAUSED: "Status: paused. No review is opened and nothing is submitted while paused.",
  ACTIVE: "Status: active.",
  NEVER_SEED: "Never send a seed phrase or private key in Telegram. Lintcha Copy never asks for one.",
  SELL_TELEGRAM_REFUSED: "SELL was not submitted. Telegram cannot confirm a SELL; review and confirm only inside the Lintcha Copy secure sheet.",
  AUTO_REFUSED: "Auto-copy is a future, disabled module and cannot be enabled from Telegram. Lintcha Copy Basic supports notifications or confirm-each only.",
  STALE: "This control is no longer valid. Open /copy again.",
  GLOBAL_PAUSED: "Lintcha Copy is paused for everyone right now. Nothing is signed or submitted.",
  REVIEW_BUY: "A source BUY matched your Lintcha Copy rule. Review the fresh simulation and confirm in the secure sheet, or ignore this message. Nothing happens without your wallet confirmation.",
  REVIEW_SELL: "A manual SELL review is ready in Lintcha Copy. Approval and trade are separate confirmations inside the secure sheet. Telegram cannot sign or submit it.",
});

function settingsText(user, globallyPaused) {
  return [
    COPY_TEXTS.HEADER, COPY_TEXTS.BOUNDARY, "",
    user.mode === "CONFIRM_EACH" ? COPY_TEXTS.MODE_CONFIRM : COPY_TEXTS.MODE_NOTIFY,
    globallyPaused ? COPY_TEXTS.GLOBAL_PAUSED : user.paused ? COPY_TEXTS.PAUSED : COPY_TEXTS.ACTIVE,
    "", COPY_TEXTS.NEVER_SEED,
  ].join("\n");
}

export class CopyTelegramSurface {
  constructor({ userStore, killSwitches, appOrigin, appPath = "/copy/", service = null }) {
    this.userStore = userStore;
    this.killSwitches = killSwitches;
    this.appUrl = new URL(appPath, appOrigin).toString();
    this.service = service;
  }

  #settings(user) {
    const paused = Boolean(user.paused);
    return {
      text: settingsText(user, this.killSwitches.globallyPaused),
      inlineKeyboard: [
        [{ text: user.mode === "NOTIFY_ONLY" ? "• Notifications" : "Notifications", callbackData: "copy.mode.notify" }, { text: user.mode === "CONFIRM_EACH" ? "• Confirm each trade" : "Confirm each trade", callbackData: "copy.mode.confirm_each" }],
        [{ text: paused ? "Resume" : "Pause", callbackData: paused ? "copy.resume" : "copy.pause" }, { text: "Status", callbackData: "copy.status" }],
        [{ text: "Open Lintcha Copy — trading", webAppUrl: this.appUrl }],
      ],
    };
  }

  /** Maps one verified gateway envelope to the constrained response contract. */
  async handle(envelope) {
    const user = await this.userStore.upsert({ telegramUserId: envelope.telegramUserId, privateChatId: envelope.privateChatId });
    if (envelope.route === "COPY_COMMAND") return this.#settings(user);
    const data = envelope.callbackData || "";
    if (data === "copy.mode.notify") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, mode: "NOTIFY_ONLY" }));
    if (data === "copy.mode.confirm_each") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, mode: "CONFIRM_EACH" }));
    if (data === "copy.pause") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, paused: true }));
    if (data === "copy.resume") return this.#settings(await this.userStore.upsert({ telegramUserId: user.telegramUserId, paused: false }));
    if (data === "copy.status") return this.#settings(user);
    if (data.startsWith("copy.mode.auto")) return { text: `${COPY_TEXTS.HEADER}\n${COPY_TEXTS.AUTO_REFUSED}` };
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
      inlineKeyboard: [[{ text: direction === "SELL" ? "Review SELL in Lintcha Copy" : "Review BUY in Lintcha Copy", webAppUrl: url.toString() }], [{ text: "Ignore", callbackData: `${direction === "SELL" ? "sell" : "trade"}.cancel` }]],
    };
  }
}

export { USER_MODES };
