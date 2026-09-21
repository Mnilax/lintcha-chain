import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createCustomCommon, Hardfork, Mainnet } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { createAccount, createAddressFromPrivateKey, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { createVM, runTx } from "@ethereumjs/vm";
import { Interface, concat, parseEther } from "ethers";
import solc from "solc";

const root = path.resolve(import.meta.dirname, "..");
const OWNER_KEY = hexToBytes(`0x${"11".repeat(32)}`);
const USER_KEY = hexToBytes(`0x${"22".repeat(32)}`);

function compile() {
  const sources = {
    "LintchaPonsAutoBuy.sol": { content: fs.readFileSync(path.join(root, "src/LintchaPonsAutoBuy.sol"), "utf8") },
    "Mocks.sol": { content: fs.readFileSync(path.join(root, "test/fixtures/Mocks.sol"), "utf8") },
  };
  const input = { language: "Solidity", sources, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(({ severity }) => severity === "error");
  assert.deepEqual(errors, [], errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  return output.contracts;
}

const compiled = compile();
const artifact = (source, name) => ({ abi: compiled[source][name].abi, bytecode: `0x${compiled[source][name].evm.bytecode.object}` });
const addressOf = (key) => createAddressFromPrivateKey(key);

async function fixture() {
  const common = createCustomCommon({ chainId: 4663, networkId: 4663 }, Mainnet, { hardfork: Hardfork.Prague });
  const vm = await createVM({ common });
  for (const key of [OWNER_KEY, USER_KEY]) await vm.stateManager.putAccount(addressOf(key), createAccount({ nonce: 0n, balance: parseEther("100") }));

  async function send(key, { to, data = "0x", value = 0n }) {
    const sender = addressOf(key);
    const account = await vm.stateManager.getAccount(sender);
    const tx = createLegacyTx({ nonce: account.nonce, gasLimit: 12_000_000n, gasPrice: 10n, to: to ? createAddressFromString(to) : undefined, value, data: hexToBytes(data) }, { common }).sign(key);
    return runTx(vm, { tx });
  }

  async function deploy(source, name, key, args = []) {
    const item = artifact(source, name);
    const iface = new Interface(item.abi);
    const result = await send(key, { data: concat([item.bytecode, iface.encodeDeploy(args)]) });
    assert.equal(result.execResult.exceptionError, undefined, result.execResult.exceptionError?.error);
    return { address: result.createdAddress.toString(), iface };
  }

  async function transact(contract, key, method, args = [], value = 0n) {
    return send(key, { to: contract.address, data: contract.iface.encodeFunctionData(method, args), value });
  }

  async function read(contract, method, args = []) {
    const result = await vm.evm.runCall({ to: createAddressFromString(contract.address), caller: addressOf(OWNER_KEY), origin: addressOf(OWNER_KEY), data: hexToBytes(contract.iface.encodeFunctionData(method, args)), gasLimit: 12_000_000n });
    assert.equal(result.execResult.exceptionError, undefined, result.execResult.exceptionError?.error);
    return contract.iface.decodeFunctionResult(method, result.execResult.returnValue);
  }

  const factory = await deploy("Mocks.sol", "MockFactory", OWNER_KEY);
  const token = await deploy("Mocks.sol", "MockToken", OWNER_KEY);
  const curve = await deploy("Mocks.sol", "MockCurve", OWNER_KEY, [factory.address, token.address]);
  const executor = await deploy("LintchaPonsAutoBuy.sol", "LintchaPonsAutoBuy", OWNER_KEY, [factory.address, addressOf(OWNER_KEY).toString()]);
  assert.equal((await transact(token, OWNER_KEY, "mint", [curve.address, parseEther("1000000")])).execResult.exceptionError, undefined);
  assert.equal((await transact(factory, OWNER_KEY, "setLaunch", [token.address, curve.address, "0x0000000000000000000000000000000000000000", 0, true])).execResult.exceptionError, undefined);
  assert.equal((await transact(executor, USER_KEY, "configure", [parseEther("0.1"), parseEther("0.15"), 100, 31_536_000])).execResult.exceptionError, undefined);
  return { send, transact, read, factory, token, curve, executor };
}

function expectedOutput(amountIn) {
  const net = amountIn * 9_800n / 10_000n;
  return net * parseEther("1000000") / (parseEther("10") + net);
}

function expectRevert(result) {
  assert.ok(result.execResult.exceptionError, "transaction unexpectedly succeeded");
}

test("starts paused, then executes a factory-derived native Pons BUY directly to the user", async () => {
  const current = await fixture();
  const amount = parseEther("0.01");
  const minimum = expectedOutput(amount) * 99n / 100n;
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, minimum], amount));
  assert.equal((await current.transact(current.executor, OWNER_KEY, "setGlobalPaused", [false])).execResult.exceptionError, undefined);
  assert.equal((await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, minimum], amount)).execResult.exceptionError, undefined);
  const [balance] = await current.read(current.token, "balanceOf", [addressOf(USER_KEY).toString()]);
  assert.ok(balance >= minimum);
  const [, spent] = await current.read(current.executor, "dailySpend", [addressOf(USER_KEY).toString()]);
  assert.equal(spent, amount);
});

test("rejects an unregistered launch and enforces per-transaction and daily caps", async () => {
  const current = await fixture();
  assert.equal((await current.transact(current.executor, OWNER_KEY, "setGlobalPaused", [false])).execResult.exceptionError, undefined);
  const amount = parseEther("0.1");
  const minimum = expectedOutput(amount) * 99n / 100n;
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [addressOf(OWNER_KEY).toString(), amount, minimum], amount));
  assert.equal((await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, minimum], amount)).execResult.exceptionError, undefined);
  const second = parseEther("0.06");
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, second, 1], second));
  const overTrade = parseEther("0.11");
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, overTrade, 1], overTrade));
});

test("has no SELL, arbitrary call, approval, upgrade, or withdrawal surface", async () => {
  const current = await fixture();
  const abi = artifact("LintchaPonsAutoBuy.sol", "LintchaPonsAutoBuy").abi;
  const names = abi.filter(({ type }) => type === "function").map(({ name }) => name);
  for (const forbidden of ["sell", "execute", "approve", "upgradeTo", "withdraw", "sweep"]) assert.equal(names.includes(forbidden), false);
  const sellData = new Interface(["function sell(address token,uint256 amount,uint256 minimumOutput)"]).encodeFunctionData("sell", [current.token.address, 1, 1]);
  expectRevert(await current.send(USER_KEY, { to: current.executor.address, data: sellData }));
});

test("user pause is immediate and only the configured wallet can spend its limits", async () => {
  const current = await fixture();
  assert.equal((await current.transact(current.executor, OWNER_KEY, "setGlobalPaused", [false])).execResult.exceptionError, undefined);
  assert.equal((await current.transact(current.executor, USER_KEY, "setUserPaused", [true])).execResult.exceptionError, undefined);
  const amount = parseEther("0.01");
  const minimum = expectedOutput(amount) * 99n / 100n;
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, minimum], amount));
  expectRevert(await current.transact(current.executor, OWNER_KEY, "buy", [current.token.address, amount, minimum], amount));
});

test("non-owner cannot change the global switch and bad quote assets or slippage fail closed", async () => {
  const current = await fixture();
  expectRevert(await current.transact(current.executor, USER_KEY, "setGlobalPaused", [false]));
  assert.equal((await current.transact(current.executor, OWNER_KEY, "setGlobalPaused", [false])).execResult.exceptionError, undefined);
  const amount = parseEther("0.01");
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, 1], amount));
  assert.equal((await current.transact(current.curve, OWNER_KEY, "setPairToken", [addressOf(OWNER_KEY).toString()])).execResult.exceptionError, undefined);
  const minimum = expectedOutput(amount) * 99n / 100n;
  expectRevert(await current.transact(current.executor, USER_KEY, "buy", [current.token.address, amount, minimum], amount));
});
