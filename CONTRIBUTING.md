# Contributing

lintcha-chain is source-first: the repository must be able to reproduce every reading the public site makes. A
change that weakens one of the eight `road.never` statements changes the product rather than extending it.

## Before proposing a change

- Use the issue forms for a reproducible bug or a product proposal.
- Do not post credentials, private RPC URLs, bot tokens, wallet secrets, signatures or unpublished vulnerability
  details in an issue, pull request, fixture or log.
- Keep the snapshot comparison about self-declared strings. It does not inspect a contract, compute a price, assign a
  score or make a recommendation.
- Do not edit a vendored file in place. `VENDOR.md` identifies those files and their source commits; a fix belongs in
  lintcha first and is copied here with an updated row.
- Do not hand-edit generated comparison files. `npm run build` writes the generated HTML, sitemap and integrity
  manifest from their authored inputs.

## Local checks

Use the Node.js version declared in `package.json`. The root package has no runtime dependencies.

Run the checks relevant to the files you changed:

```text
npm test
npm ci --prefix bot
npm test --prefix bot
npm run bundle --prefix bot
npm run i18n
npm run build
node tools/verify-vendor.mjs
```

After a build, confirm that only the generated files you intended to update changed. The pull request workflows run
the complete root and bot suites, translation check, deterministic build, browser contracts and vendor verification.

The collection and publication workflow is deliberately manual and fail-closed. Do not run it merely to make a test
green, and never replace a missing historical read with a guessed value.

## Pull requests

Keep one concern per pull request. Describe the source of every new public fact, the exact checks you ran and any
limit the change cannot prove. A pull request is merged only after the required `test` and `verify-vendor` checks pass
for its exact head commit.
