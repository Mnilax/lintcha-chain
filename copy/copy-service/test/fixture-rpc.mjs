import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Deterministic JSON-RPC replay over a recorded mainnet transaction fixture. Two instances with different ids
 * act as the two independent providers. It answers only what the fixture records; anything else throws, so a
 * test cannot accidentally depend on a value nobody captured.
 */
export function loadFixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));
}

export function fixtureProvider(id, fixture, { allowance = null, head = null } = {}) {
  const blockNumber = Number(BigInt(fixture.block.number));
  const headNumber = head ?? blockNumber;
  const calls = [];
  return {
    id, calls,
    async request(method, params = []) {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId": return "0x1237";
        case "eth_blockNumber": return `0x${headNumber.toString(16)}`;
        case "eth_getBlockByNumber": {
          const tag = params[0];
          const number = tag === "safe" || tag === "finalized" ? headNumber : Number(BigInt(tag));
          if (number === blockNumber) return { number: fixture.block.number, hash: fixture.block.hash, parentHash: fixture.block.parentHash };
          return { number: `0x${number.toString(16)}`, hash: `0x${number.toString(16).padStart(64, "0")}`, parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}` };
        }
        case "eth_call":
          if (String(params[0]?.data || "").startsWith("0xdd62ed3e")) { if (allowance === null) throw new Error("FIXTURE_HAS_NO_ALLOWANCE"); return `0x${BigInt(allowance).toString(16).padStart(64, "0")}`; }
          return fixture.simulation.ethCall;
        case "eth_estimateGas": return fixture.simulation.estimateGas;
        case "eth_getTransactionByHash": return String(params[0]).toLowerCase() === fixture.transaction.hash.toLowerCase() ? structuredClone(fixture.transaction) : null;
        case "eth_getTransactionReceipt": return String(params[0]).toLowerCase() === fixture.transaction.hash.toLowerCase() ? structuredClone(fixture.receipt) : null;
        default: throw new Error(`FIXTURE_METHOD_NOT_RECORDED_${method}`);
      }
    },
  };
}
