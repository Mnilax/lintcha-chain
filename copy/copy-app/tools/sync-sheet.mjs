// The sheet controller has one source: secure-sheet-crypto/src/confirm-each.mjs. This copies it next to the
// Mini App so the page imports it as a same-origin module. A test refuses a drifted copy.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../../secure-sheet-crypto/src/confirm-each.mjs", import.meta.url));
const target = fileURLToPath(new URL("../copy/confirm-each.mjs", import.meta.url));
copyFileSync(source, target);
console.log("synced confirm-each.mjs");
