import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MainnetObserverAdapter } from "../src/observer/mainnet-adapter.mjs";
import { PonsV2CurveObserverAdapter } from "../src/observer/pons-v2-adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(resolve(here, `fixtures/${name}`), "utf8"));
}

test("CP9 mainnet: Pons V2 direct curve BUY is decoded from a real receipt", async () => {
  const value = await fixture("pons-v2-mainnet-buy.json");
  const decoded = new PonsV2CurveObserverAdapter().decode(value, value.transaction.from);
  assert.equal(decoded.direction, "BUY");
  assert.equal(decoded.venue, "Pons V2 Bonding Curve");
  assert.equal(decoded.targetToken, value.context.ponsV2Launch.token.toLowerCase());
  assert.equal(decoded.pairToken, "0x0000000000000000000000000000000000000000");
  assert.equal(decoded.sourceAmount, BigInt(value.transaction.value).toString());
  assert.ok(BigInt(decoded.actualOutput) > 0n);
});

test("CP9 mainnet: Pons V2 direct curve SELL is decoded from a real receipt", async () => {
  const value = await fixture("pons-v2-mainnet-sell.json");
  const decoded = new PonsV2CurveObserverAdapter().decode(value, value.transaction.from);
  assert.equal(decoded.direction, "SELL");
  assert.equal(decoded.sourceAmount, BigInt(`0x${value.transaction.input.slice(10, 74)}`).toString());
  assert.ok(BigInt(decoded.actualOutput) > 0n);
});

test("CP9 mainnet: forged factory provenance fails closed", async () => {
  const value = await fixture("pons-v2-mainnet-buy.json");
  value.context.ponsV2Launch.factory = "0x0000000000000000000000000000000000000001";
  assert.throws(
    () => new PonsV2CurveObserverAdapter().decode(value, value.transaction.from),
    (error) => error.code === "UNSUPPORTED_FACTORY",
  );
});

test("CP9 mainnet: recipient different from watched wallet fails closed", async () => {
  const value = await fixture("pons-v2-mainnet-buy.json");
  value.transaction.input = `${value.transaction.input.slice(0, -40)}0000000000000000000000000000000000000001`;
  assert.throws(
    () => new PonsV2CurveObserverAdapter().decode(value, value.transaction.from),
    (error) => error.code === "RECIPIENT_MISMATCH",
  );
});

test("CP9 mainnet: adapter registry accepts Pons and keeps unknown venues closed", async () => {
  const value = await fixture("pons-v2-mainnet-buy.json");
  const adapter = new MainnetObserverAdapter();
  assert.equal(adapter.decode(value, value.transaction.from).direction, "BUY");
  value.context.ponsV2Launch = null;
  assert.throws(() => adapter.decode(value, value.transaction.from), (error) => error.code === "UNSUPPORTED_VENUE");
});
