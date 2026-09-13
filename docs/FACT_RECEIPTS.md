# Fact-receipt verification and replay

The comparison page creates `lintcha-chain/fact-receipt/v1` JSON locally. It records the exact form fields used for one read, the localized lines rendered by that read, and the published snapshot context printed by the page.

A receipt remains portable context, not independent proof. It is not signed. These commands do not turn it into a rating, inspect a contract, resolve an address, or read a private corpus.

## Check the receipt itself

```sh
node tools/identity.mjs receipt-verify --receipt lintcha-chain-fact-receipt.json
```

This command checks the exact v1 envelope, source/language route, block and time bounds, input fields, and bounded result-row shape. It also prints the SHA-256 of the exact receipt file bytes so those bytes can be identified later.

It deliberately reports:

- `corpus_checked: false`
- `result_replayed: false`
- `independent_proof: false`

A changed sentence can still be structurally valid. Use replay to ask whether the receipt follows from a particular published corpus.

## Replay it against the checked-in snapshot

```sh
node tools/identity.mjs receipt-replay --receipt lintcha-chain-fact-receipt.json
```

The default replay performs all of these checks locally:

1. validate the receipt structure;
2. bind `site/launch-index.json` and `site/launch-numbers.json` to `site/launch-manifest.json` by exact byte length and SHA-256;
3. validate the index grammar and manifest namespace counts;
4. require the receipt's index hash and block/time window to match those artifacts;
5. run the receipt input through `LINTCHA_12` again;
6. render that fresh result with the receipt language and require an exact match with every stored result line.

A successful replay reports `result: "reproduced"`. It also reports `chain_rebuilt: false` and `independent_proof: false`: this command replays a read against already-published artifacts. It does not re-read Robinhood Chain or rebuild the snapshot. `npm run verify` is the separate strict snapshot-rebuild path.

No receipt command performs network I/O. `--receipt -` reads the receipt from standard input.

## Replay a preserved artifact set

An older or external corpus must be supplied as one complete set:

```sh
node tools/identity.mjs receipt-replay \
  --receipt receipt.json \
  --index preserved/launch-index.json \
  --manifest preserved/launch-manifest.json \
  --numbers preserved/launch-numbers.json
```

Supplying only part of that set is refused. The manifest binds both data files; the numbers file binds the receipt's window; the receipt binds the index digest.

Localized rendered copy can change independently of the comparison engine. To replay the exact wording of an older receipt, pass the matching preserved translation document:

```sh
node tools/identity.mjs receipt-replay \
  --receipt receipt.json \
  --index preserved/launch-index.json \
  --manifest preserved/launch-manifest.json \
  --numbers preserved/launch-numbers.json \
  --translations preserved/launch.en.json
```

Only one input document can use `-` in a single invocation.
