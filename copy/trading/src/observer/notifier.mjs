import { deterministicId } from "../utils.mjs";

function shortAddress(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function telegramSignal(event, { targetAlias, manualSellToken } = {}) {
  const title = event.state === "RETRACTED" ? "Source trade retracted" : "Copy signal";
  const text = [
    title,
    `Target: ${String(targetAlias ?? "Wallet").slice(0, 48)} (${shortAddress(event.sourceWallet)})`,
    `Direction: ${event.direction}`,
    `Token: ${shortAddress(event.targetToken)}`,
    `Source amount: ${event.sourceAmount}`,
    `Source state: ${event.state}`,
    `Tx: ${shortAddress(event.transactionHash)}`,
  ].join("\n");
  const callbackToken = deterministicId("signal", event.sourceId).slice(0, 24);
  const buttons = event.state !== "RETRACTED"
    ? [[
        { text: "Details", callback_data: `signal.details.${callbackToken}` },
        { text: "Copy rule", callback_data: `signal.rule.${callbackToken}` },
      ]]
    : [];
  if (event.direction === "SELL" && ["CONFIRMED", "FINALIZED"].includes(event.state) && manualSellToken) {
    buttons.push([{ text: "Sell manually", callback_data: `sell.review.${manualSellToken}` }]);
  }
  return Object.freeze({ text, reply_markup: { inline_keyboard: buttons }, sourceId: event.sourceId, revision: event.revision });
}
