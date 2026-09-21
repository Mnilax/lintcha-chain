import { normalizeAddress } from "../utils.mjs";

function alias(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 64 || /[<>\u0000-\u001f]/.test(text)) throw new TypeError("invalid wallet alias");
  return text;
}

export function walletCard(wallet, { secureSheetBaseUrl, callbackFor }) {
  if (typeof callbackFor !== "function") throw new TypeError("opaque callback factory required");
  const address = normalizeAddress(wallet.publicAddress);
  const name = alias(wallet.alias);
  return Object.freeze({
    text: [`Wallet: ${name}`, `Address: ${address}`, `Balance: ${wallet.balance ?? "—"}`].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Copy address", callback_data: callbackFor("copy") }],
        [{ text: "Deposit", callback_data: callbackFor("deposit") }, { text: "Transfer", callback_data: callbackFor("transfer") }],
        [{ text: "Rename", callback_data: callbackFor("rename") }, { text: "Recovery", url: `${secureSheetBaseUrl}?action=recovery&wallet=${encodeURIComponent(wallet.id)}` }],
        [{ text: "Delete", callback_data: callbackFor("delete") }],
      ],
    },
  });
}
