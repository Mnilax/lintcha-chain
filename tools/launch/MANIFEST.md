# Launch identity: copy manifest (LINTCHA_12)

The handoff document for the second repository. Two lists: what to copy to stand the section up on an empty
repository, and what the section needs but does not own. Kept current with every change to the section; the
acceptance's extraction check scans this file too.

The switch is `site/flags.json` `{ "launch": true }`. The one file a copy edits to point somewhere else is
`site/launch-site.json` (the three absolute addresses per language: checker, method, library). The section's strings
are emitted by the build as `build/launch-i18n.<lang>.json` (the 46 `launch.*` keys and `nav.launch`, per language),
so copying strings is copying a file; in this repository they live inside `site/i18n/<lang>.json`.

## 1. to copy

```
site/flags.json                        the switch
site/launch-site.json                  the three absolute addresses per language; the file a copy edits
site/templates/launch.html             the page: shell markup, form, results, fixed paragraph; links via {{site_*}}, assets root-absolute
site/launch.js                         the engine: normalizers, digest, check()
site/launch-skeleton.js                the skeleton table (one file, under fifty lines)
site/launch-links.js                   the link alias table
site/launch-page.js                    the page script: form, one fetch of the index on the first check, rows
site/launch.css                        the section's stylesheet, on top of style.css tokens
site/launch-index.json                 the frozen index of counted hashes
site/launch-numbers.json               the frozen figures the page prints
build/launch-i18n.en.json              the section's strings, emitted by the build (46 launch.* keys + nav.launch)
build/launch-i18n.es.json
build/launch-i18n.pt.json
site/tools/build.js                    the fenced block only: "// --- launch section, LINTCHA_12: lift or delete as one block"
                                       to "// --- end launch section" (the flag, pages, files, frozen files, vars, tokens, emit)
tools/build-library.mjs                the fenced block only, same fences (the flag, the nav item, the dropped keys)
tools/launch-collect.mjs               the collector (RPC only, own limiter, ABI and keccak)
tools/launch-index.mjs                 the index and numbers writer
tools/launch-index-schema.json         the index schema
tools/launch/abi.mjs                   ABI fragments and codec
tools/launch/keccak.mjs                keccak256, selector, topic
tools/launch/rpc.mjs                   the rate gate
tools/launch/schema.mjs                the schema checker
tools/launch/MANIFEST.md               this file
tests/launch_test.js                   engine, tables row by row, criteria 4 to 6
tests/launch_abi_test.mjs
tests/launch_collector_state_test.mjs  fixed finalized identity-state capture, reuse and recheck
tests/launch_gate_test.mjs
tests/launch_index_test.mjs
tests/launch_browser.mjs               criteria 1 and 2, headless Chrome over the DevTools protocol
tests/launch_extraction.mjs            the extraction constraint, file by file
tests/launch_acceptance.sh             the ten criteria
```

## 2. needed but not owned

```
site/style.css                         the tokens (--ink, --ink-2, --ink-3, --field, --line, --panel, --btn) and the shell styles
site/ui-controls.js                    theme toggle and language select; the two storage keys lintcha:theme, lintcha:lang
site/fonts/archivo.woff2
site/fonts/ibm-plex-mono-400.woff2
site/fonts/ibm-plex-mono-600.woff2
site/icon-32.png  site/icon-180.png  site/icon-512.png  site/og.png
manifest.webmanifest                   written by the build
site/i18n/<lang>.json chrome keys      app.name, nav.tool, nav.method, nav.library, nav.checker, nav.soon, nav.label,
                                       theme.dark, theme.light, lang.label, footer.rules ({rules} from rules.js), footer.privacy,
                                       footer.submit_role, contact.telegram, contact.x
site/templates/index.html, method.html, tools/templates/library-*.html
                                       carry the {{nav_launch}} slot (empty when the flag is off)
site/tools/build.js (outside the block) the renderer: pages in directories, the i18n island, fillI18n, the sitemap, _headers,
                                       and the seam object SECTION the block fills
tools/build-library.mjs (outside the block) the seam object SECTION and the nav_launch token
site/tools/i18n_check.js               the coverage gate over i18n/<lang>.json
tests/console_check.sh                 criterion 8
site/_headers                          the CSP with the inline theme script's hash (the launch page carries the same script)
```
