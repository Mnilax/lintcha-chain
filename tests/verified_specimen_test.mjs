import fs from "node:fs";
import { check, validateIdentityInput } from "../lib/identity.mjs";

let checks = 0;
function ok(value, message) {
  checks++;
  if (!value) throw new Error(message);
}

const specimen = JSON.parse(fs.readFileSync(new URL("../fixtures/verified-specimen.json", import.meta.url), "utf8"));
const index = JSON.parse(fs.readFileSync(new URL("../site/launch-index.json", import.meta.url), "utf8"));

ok(specimen.schema === "lintcha-chain/verified-specimen/v1", "specimen schema");
ok(specimen.kind === "synthetic", "specimen is explicitly synthetic");
ok(validateIdentityInput(specimen.input) === specimen.input, "specimen crosses the public strict input boundary");

const result = await check(specimen.input, index);
ok(result.N2.state === "shared", "specimen keeps a shared exact name in the current shipped snapshot");
ok(result.N3.ticker.state === "lookalike", "specimen keeps a ticker lookalike in the current shipped snapshot");
ok(result.I1.links.twitter.state === "shared", "specimen keeps a shared link in the current shipped snapshot");
ok(result.I1.links.website.state === "unique", "specimen keeps a unique link in the current shipped snapshot");
ok(result.I3.state === "not readable", "specimen demonstrates an unreadable recipient without resolving it");
ok(result.I4.state === "unique", "specimen description crosses the comparison floor");

for (const value of Object.values(specimen.input)) {
  if (typeof value === "string") ok(!/https?:\/\//i.test(value), "specimen carries no fetchable URL");
}

console.log(`verified specimen test: ${checks} checks`);
