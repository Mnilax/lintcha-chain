import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(import.meta.dirname, "..");
const sources = {
  "LintchaPonsAutoBuy.sol": { content: fs.readFileSync(path.join(root, "src/LintchaPonsAutoBuy.sol"), "utf8") },
};
const input = { language: "Solidity", sources, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } } };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((item) => item.severity === "error");
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
const artifact = output.contracts["LintchaPonsAutoBuy.sol"].LintchaPonsAutoBuy;
const outDir = path.join(root, "artifacts");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "LintchaPonsAutoBuy.json"), `${JSON.stringify({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, deployedBytecode: `0x${artifact.evm.deployedBytecode.object}` }, null, 2)}\n`);
console.log("Compiled LintchaPonsAutoBuy");
