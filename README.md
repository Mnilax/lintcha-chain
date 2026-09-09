<p align="center"><img src="assets/avatar.png" width="128" height="128" alt=""></p>
<p align="center"><img src="assets/banner.png" alt="lintcha-chain" width="100%"></p>
<p align="center">
<img alt="tests" src="https://img.shields.io/badge/tests-319_passing-d4fc50?labelColor=08090a&style=flat-square">
<img alt="node" src="https://img.shields.io/badge/node-%3E%3D24-5e5a53?labelColor=08090a&style=flat-square">
<img alt="runtime deps" src="https://img.shields.io/badge/runtime_deps-0-5e5a53?labelColor=08090a&style=flat-square">
<img alt="chain" src="https://img.shields.io/badge/chain-4663-5e5a53?labelColor=08090a&style=flat-square">
<img alt="index" src="https://img.shields.io/badge/index-24%2C621_entries-5e5a53?labelColor=08090a&style=flat-square">
<img alt="window" src="https://img.shields.io/badge/window-one_day%2C_weekly-5e5a53?labelColor=08090a&style=flat-square">
<img alt="licence" src="https://img.shields.io/badge/licence-MIT-d4fc50?labelColor=08090a&style=flat-square">
</p>
<!-- the token line, when there is a token: uncomment and paste the contract
<p align="center"><b>$LINTCHA</b> · <code>0x...</code></p>
-->

# lintcha-chain

The second site of lintcha, live at [chain.lintcha.com](https://chain.lintcha.com/). One page that reads what a launch
on Robinhood Chain calls itself, its name, ticker, description, five link fields, logo and fee recipient, and reports
what those strings are shared with across one day of launches: how many carry the same value, from how many
deployers, and since when. It reads strings. It does not read the contract, price anything, score anything or predict
anything.

## What is here

- `site/` is the served directory, static, as it is. `site/index.html`, `site/404.html` and `site/sitemap.xml` are
  written by the build; `site/launch-index.json` and `site/launch-numbers.json` are written by the index writer and
  refreshed weekly; everything else under `site/` is either a copy from lintcha or a file this repository owns (see
  VENDOR.md).
- `src/templates/shell.html` is the page around the vendored tool, `src/templates/404.html` the same shell around two
  strings; `src/i18n-src/chain.<lang>.json` are this site's strings, `src/i18n-src/launch.<lang>.json` the vendored
  ones. The build merges them into `src/i18n/<lang>.json`.
- `tools/build.mjs` builds the page; `tools/build-viz.mjs` the three charts and the ornament from the index;
  `tools/build-method.mjs` the method section's tables from the engine's own files; `tools/verify-vendor.mjs` checks
  the vendored files against VENDOR.md; `tools/verify-index.mjs` is `npm run verify`.
- `tools/launch-collect.mjs` and `tools/launch-index.mjs` (vendored) read one day of launches from the public RPC and
  write the index and the numbers file.
- `tests/` carries the vendored engine tests and this site's own: `chain_acceptance.sh` (the fourteen criteria),
  `chain_browser.mjs`, `chain_token_states.mjs`.
- `assets/` is the brand kit: the avatar and the banner above. The site's icons, the social card and the header mark
  (`site/mark-acid.png`) are the same mark.

## Vendored, not edited

lintcha is the source of the engine. Every copied file is a row in VENDOR.md with its sha256 and the lintcha commit it
came from, and is never edited here: a fix goes to lintcha first and is copied back with a new row. Files this
repository writes itself are listed under "owned here" in the same document; a path is added there in the commit that
creates the file. `node tools/verify-vendor.mjs` reports any mismatch, missing, unlisted or duplicate file, and runs in
CI on every push (`.github/workflows/vendor.yml`).

## Build and test

Node 24, no dependency.

```
npm run build     merge the strings, build site/index.html, site/404.html and site/sitemap.xml from the templates, the numbers file and the index
npm test          verify-vendor, the token block's three states, the engine, ABI, gate and index tests
npm run i18n      merge the strings and run the vendored i18n check (three languages, en emitted)
npm run verify    re-run the collector over the recorded window, rebuild the index, print both hashes
bash tests/chain_acceptance.sh     the fourteen criteria, each with the command that ran it
```

Every figure on the page arrives by substitution from `site/launch-numbers.json` or `site/launch-index.json`; the
build refuses a digit in a template's text or in a string, and its comment names the only other sources (the section
numbers, the engine's tables; the specimen in the diagram carries letters, not figures). The site's origin, used for
the canonical link, the social card and the sitemap, is the `origin` key of `site/launch-site.json`.

## Where the badge figures come from

The badges above are static images from shields.io, which GitHub renders; nothing under `site/` loads from there.
Each figure is read from the tree, not typed from memory:

```
tests           npm test                                    the five suites that print a count: 19 + 191 + 37 + 18 + 54 = 319 checks
node            package.json, engines.node                  >=24
runtime deps    package.json                                no "dependencies" key
chain           site/launch-numbers.json, chain_id          4663
index           site/launch-numbers.json, index.entries_total
window          site/launch-numbers.json, window.hours; .github/workflows/launch-refresh.yml, the cron
licence         LICENSE                                     MIT
```

When the weekly refresh lands a new index, the index badge is a line to edit here; nothing on the page depends on it.

## The weekly refresh

`.github/workflows/launch-refresh.yml` runs the collector over the most recent full day, rebuilds the index, the numbers
file and the page, and commits those three files when every guard passes: a non-empty window, every launch read, at
least half of the published day collected, the schema, the engine and index tests, verify-vendor before, between and
after, and a membership test that allows exactly those three paths to have changed.

## The token

`site/token.json` ships with every value null and the page carries no token block, no address and no buy link. When an
address and a pons link exist, the block renders from that one file; a uniswap link adds its own button. The three
states are checked by `tests/chain_token_states.mjs` against temporary files, never the tree.

## Licence

MIT, see LICENSE. Not affiliated with Robinhood, pons or any launchpad, and using none of their marks.
