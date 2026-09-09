# lintcha-chain

The second site of lintcha. One page that reads what a launch on Robinhood Chain calls itself, its name, ticker,
description, five link fields, logo and fee recipient, and reports what those strings are shared with across one day
of launches: how many carry the same value, from how many deployers, and since when. It reads strings. It does not
read the contract, price anything, score anything or predict anything.

## What is here

- `site/` is the served directory, static, as it is. `site/index.html` is written by the build; `site/launch-index.json`
  and `site/launch-numbers.json` are written by the index writer and refreshed weekly; everything else under `site/`
  is either a copy from lintcha or a file this repository owns (see VENDOR.md).
- `src/templates/shell.html` is the page around the vendored tool; `src/i18n-src/chain.<lang>.json` are this site's
  strings, `src/i18n-src/launch.<lang>.json` the vendored ones. The build merges them into `src/i18n/<lang>.json`.
- `tools/build.mjs` builds the page; `tools/build-viz.mjs` the three charts and the ornament from the index;
  `tools/build-method.mjs` the method section's tables from the engine's own files; `tools/verify-vendor.mjs` checks
  the vendored files against VENDOR.md; `tools/verify-index.mjs` is `npm run verify`.
- `tools/launch-collect.mjs` and `tools/launch-index.mjs` (vendored) read one day of launches from the public RPC and
  write the index and the numbers file.
- `tests/` carries the vendored engine tests and this site's own: `chain_acceptance.sh` (the fourteen criteria),
  `chain_browser.mjs`, `chain_token_states.mjs`.

## Vendored, not edited

lintcha is the source of the engine. Every copied file is a row in VENDOR.md with its sha256 and the lintcha commit it
came from, and is never edited here: a fix goes to lintcha first and is copied back with a new row. Files this
repository writes itself are listed under "owned here" in the same document; a path is added there in the commit that
creates the file. `node tools/verify-vendor.mjs` reports any mismatch, missing, unlisted or duplicate file, and runs in
CI on every push (`.github/workflows/vendor.yml`).

## Build and test

Node 24, no dependency.

```
npm run build     merge the strings, build site/index.html from the templates, the numbers file and the index
npm test          verify-vendor, the token block's three states, the engine, ABI, gate and index tests
npm run i18n      merge the strings and run the vendored i18n check (three languages, en emitted)
npm run verify    re-run the collector over the recorded window, rebuild the index, print both hashes
bash tests/chain_acceptance.sh     the fourteen criteria, each with the command that ran it
```

Every figure on the page arrives by substitution from `site/launch-numbers.json` or `site/launch-index.json`; the
build refuses a digit in a template's text or in a string, and its comment names the only other sources (the section
numbers, the engine's tables, the specimen in the diagram).

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
