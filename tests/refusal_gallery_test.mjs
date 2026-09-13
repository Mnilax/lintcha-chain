import fs from "node:fs";
import { check, normalize } from "../lib/identity.mjs";

let checks = 0;
function ok(value, message) {
  checks++;
  if (!value) throw new Error(message);
}

const empty = await check({}, {});
ok(empty.N1.state === "empty", "an empty field stays empty");
const short = await check({ description: "short description" }, {});
ok(short.I4.state === "too short to compare", "a short description is refused below the floor");
const recipient = await check({ recipient: "not an address" }, {});
ok(recipient.I3.state === "not readable", "invalid recipient text stays unreadable");
ok(normalize.link("https://t.co/example") === "t.co/example", "a shortener is not expanded");

const template = fs.readFileSync(new URL("../src/templates/shell.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../site/refusal-gallery.js", import.meta.url), "utf8");
const languages = ["en", "es", "pt"];
ok((template.match(/data-refusal-tab=/g) || []).length === 5, "five refusal tabs");
ok((template.match(/data-refusal-panel=/g) || []).length === 5, "five refusal panels");
ok(template.includes('role="tablist"') && template.includes('role="tabpanel"'), "tab semantics are explicit");
ok(script.includes("ArrowRight") && script.includes("ArrowLeft") && script.includes("Home") && script.includes("End"), "keyboard navigation is complete");
ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/.test(script), "gallery is network-silent");
for (const lang of languages) {
  const strings = JSON.parse(fs.readFileSync(new URL(`../src/i18n-src/launch.${lang}.json`, import.meta.url), "utf8"));
  for (const key of ["refusal.intro", "refusal.empty.answer", "refusal.short.answer", "refusal.recipient.answer", "refusal.redirect.answer", "refusal.meaning.answer"]) {
    ok(typeof strings[key] === "string" && strings[key].length > 0, `${lang} carries ${key}`);
  }
}

console.log(`refusal gallery test: ${checks} checks`);
