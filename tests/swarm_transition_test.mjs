import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const js = read("site", "swarm-transition.js");
const css = read("site", "chain.css");
const shell = read("src", "templates", "shell.html");
const live = read("site", "live", "index.html");
const deployer = read("site", "deployer", "index.html");

let checks = 0, failures = 0;
const ok = (condition, label) => { checks += 1; if (!condition) { failures += 1; console.error("  FAIL " + label); } };

ok(shell.includes('<script src="{{root}}swarm-transition.js"></script>') && live.includes('<script src="/swarm-transition.js"></script>') && deployer.includes('<script src="/swarm-transition.js"></script>'), "every page switch loads the same transition controller");
ok(/count = narrow \? 24 : 42/.test(js) && /index % 4 === 0/.test(js), "the desktop teaser density and reverse-flight cadence are retained with a smaller mobile swarm");
ok(/prefers-reduced-motion: reduce/.test(js) && /if \(media && media\.matches\) return/.test(js), "reduced-motion navigation is immediate");
ok(/target\.origin !== window\.location\.origin/.test(js) && /link\.target.*_blank/.test(js), "only same-origin in-tab page switches are delayed");
ok(/window\.setTimeout\(function \(\) \{ window\.location\.assign\(target\.href\); \}, 620\)/.test(js), "navigation waits only for the short transition peak");
ok(/\.bat-swarm \{ position:fixed/.test(css) && /pointer-events:none/.test(css) && /z-index:999/.test(css), "the overlay cannot intercept input and sits above the departing page");
ok(/\.hero-bat-stage \{[^}]*clamp\(148px,19vw,218px\)/.test(css) && /@media \(max-width:640px\)[\s\S]*?\.hero-bat-stage \{ width:96px; \}/.test(css), "the hero bat is enlarged on desktop and mobile");
ok(/\.hero-lockup-bat \{[^}]*image-rendering:pixelated; \}/.test(css) && !/\.hero-lockup-bat \{[^}]*drop-shadow/.test(css), "the animated hero bat has no frame-following glow");
ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|\beval\s*\(/.test(js), "the visual transition has no network, storage, analytics or dynamic-code path");

console.log(`swarm transition: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
