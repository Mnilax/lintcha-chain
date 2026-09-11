# bot

The room's half of lintcha. It reads the chain and answers, and it does nothing else.

The code is here because the page already promises it is. The roadmap on
`chain.lintcha.com` carries this sentence in production:

> Everything the bot says is read from the chain, and its code ships in this repository
> with the rest.

So it ships here, in its own folder with its own `wrangler.toml`, so that the site's
config and the bot's config cannot disturb each other.

## What is in here

    wrangler.toml     the worker: name, routes, bindings, migrations, the cron, the settings
    package.json      type module, the scripts, and one exact dev dependency: Wrangler 4.131.0
    src/index.js      the worker. Five routes and a cron, and nothing else answers
    src/router.js     the commands. Returns actions and sends nothing, so a test can read what it would say
    src/texts.js      every sentence the bot can say
    src/telegram.js   sending, and the small amount of markup
    src/chain.js      the site's token.json, and every read of the chain
    src/tape.js       the feed, one Durable Object on SQLite
    src/verify.js     the holder check: the one time mark, the signature, the threshold, the session
    src/rpc.js        the limiter, vendored. See below
    src/keccak.js     keccak256, for selectors, topics and the signature hash
    src/secp256k1.js  public key recovery, for the holder check
    src/watch.js      the watcher: the launch log's live tail, and the rules read against it
    src/rules.js      what a holder asked to be told about, and whether a launch matches it
    src/engine.js     site/launch.js, loaded and never copied. See below
    src/engine-globals.js  the two vendored tables the engine needs, put where it looks for them
    src/tally.js      counting launches the way the collector counts them
    tools/verify-tail.mjs  rebuild the tail's block range with the collector and compare
    test/*_test.mjs   the local test scripts named below; no test uses the live network

## The limiter is vendored, not written

`src/rpc.js` is `tools/launch/rpc.mjs` copied byte for byte. Same class, same two in
flight, same six hundred milliseconds between starts and fifteen hundred for `eth_getLogs`,
same doubling wait on a four hundred and twenty-nine, same user agent. It is not edited and
it must not be: the endpoint's edge refuses anonymous library signatures, and the collector
already found the settings that work.

    source     tools/launch/rpc.mjs
    sha256     53c3e6ce390bb6981c172c02547289d9b7ff71ec92c46a12c0a0ca7364201913
    identical  yes, byte for byte, and that hash is the one VENDOR.md records for the source

There is one RPC client in this repository and this is a copy of it. A second one is not
written here, and `src/chain.js` puts every call through this Gate.

## The address is the site's, and only the site's

The bot does not store the token address. It reads
`https://chain.lintcha.com/token.json` and keeps the answer in the isolate's memory for
at most a minute. A cache miss has a five-second abort and streams at most one kilobyte;
declared or chunked overflow, truncation, invalid UTF-8/JSON and non-success responses all
produce the unreadable state and never leave a stale activation document in cache.

That is the whole point of the arrangement: **on the day of the launch, the same one file
edit that lights the acid band on the page turns the bot on.** There is no second place
for the address to disagree with the site.

While `address` is null:

    /ca /price /me /verify /stats        say the token does not exist yet
    the feed                             does not start, and no alarm is set at all

A site that cannot be read is a third state with its own sentence. It is never collapsed
into "there is no token", because that would be telling somebody a fact about the token
when what actually happened was a network fault.

## Setting it up

1. **A KV namespace** called `lintcha-chain-sessions`, bound as `SESSIONS`. Put its id in
   `wrangler.toml`, replacing the placeholder. It contains only the holder sessions:

        session:<tg id>     -> the address that signed           three days

   One-time marks do not use eventual-consistency KV. They live for fifteen minutes in the
   `holder_nonce` SQLite table inside the existing `Watch` Durable Object, where one synchronous
   take deletes and returns a mark's owner atomically. Two concurrent holder posts therefore
   cannot both spend the same mark. The existing minute watchdog physically removes expired unused
   rows. Neither store keeps a signature, an IP, purchase history or an address for a failed holder.

   The same object claims each positive, exactly representable Telegram `update_id` before a command
   can write or send. Its response ledger stores the rendered actions and their next unsent position;
   its effect ledger makes `/verify`, `/rule`, `/unrule` and `/forget` mutations return their first
   result when the same update is retried after a worker failure. Render and per-action leases stop two
   local requests from doing the same work concurrently. A duplicate whose lease is still active gets
   a retryable service response; a completed duplicate gets two hundred without running again. Rows are
   removed at the [Telegram Bot API](https://core.telegram.org/bots/api#getting-updates)'s documented
   twenty-four-hour webhook retention boundary.

2. **The room's chat id** in `ROOM_CHAT_ID`. Until it is set the feed still records buys
   and posts nothing, which is the right way round: no chat id must never mean no records.

   Add `@lintchabot` to the public [lintcha room](https://t.me/lintcha) as an ordinary member,
   and confirm in Telegram itself that the target is a group or supergroup (not a channel) and
   that ordinary members, including the bot, may post. The webhook intentionally subscribes only
   to `message` and `edited_message`; a channel is not a supported room.

   Read the existing webhook before making any change, then discover the numeric room id without
   putting the bot token in argv, an environment variable, a file or shell history:

        npm run telegram:webhook-info
        npm run telegram:discover

   If the first command reports `configured: true`, stop and review its safe status before changing
   or deleting anything. The discovery helper accepts credentials only from a masked interactive
   terminal, first verifies `lintchabot` with `getMe`, then resolves the fixed public username
   `@lintcha` with `getChat`. It proves those identities and that Telegram describes the target as a
   group or supergroup; it cannot prove membership or permission to send. Copy only the returned
   numeric `chat.id` into `ROOM_CHAT_ID`. It refuses redirected identities and never prints a token
   or a remote Telegram error body.

   Put the exact BotFather username in `BOT_USERNAME`, without `@`. Telegram usernames are
   case-insensitive, contain only Latin letters, digits and underscores, are five to thirty-two
   characters long, and a bot username ends in `bot`. The worker accepts `/command@username`
   only when that suffix matches this setting; a command addressed to another bot is silence.

3. **Install and pass the local production gate** from this folder. `package.json` pins Wrangler
   `4.131.0` as the sole
   dev dependency (and `package-lock.json` pins its resolved tree); the Worker has no runtime npm
   dependency. The migrations create the SQLite-backed `Tape` and `Watch` classes. Their delivery,
   nonce and webhook-dedupe tables are created idempotently by those already-existing class schemas,
   so none needs a new class or Wrangler migration tag. An existing deployment applies only migration
   tags it has not already recorded.

        npm ci
        npm run check-config:production

4. **Close public aliases, then stage both secrets without sending traffic to them.** Never store either
   secret as a plain variable. Before the first secret write, open this Worker's **Settings > Domains &
   Routes** in Cloudflare, disable both [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
   and [Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/), then read the
   same controls back as disabled. The checked-in false settings keep them disabled on the later deploy; closing a
   pre-existing alias first also prevents transient exposure while Wrangler reconciles the new deployment.

   Immediately before the first secret write, inspect both remote lists and continue only if the latest Worker
   version is still exactly the version receiving all production traffic. If the Worker does not exist, or an
   undeployed latest version already exists, stop and review it.

        npm exec -- wrangler versions list
        npm exec -- wrangler deployments list
        npm exec -- wrangler versions secret put TELEGRAM_BOT_TOKEN
        npm exec -- wrangler versions secret put TELEGRAM_WEBHOOK_SECRET
        npm exec -- wrangler versions view VERSION_ID_PRINTED_BY_SECOND_SECRET_COMMAND

   Each secret command reads its value through Wrangler's masked interactive prompt and creates a
   new **undeployed** version; it does not change production traffic. The second version inherits
   the first secret. Its `versions view` output must name both `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_WEBHOOK_SECRET` before deployment. It does not reveal their values. Do not pipe a value,
   put it in a file or environment variable, or deploy the intermediate secret version. The webhook
   secret must use only `A-Z`, `a-z`, `0-9`, `_` and `-`, with at least one and at most 256 characters,
   as required by Telegram's `secret_token` contract.

5. **Deploy the audited source and its migrations** from the repository root:

        npm run deploy --prefix bot

   `npm run deploy` is the only supported production entrypoint: npm runs `predeploy` first, which
   refuses an empty or malformed `ROOM_CHAT_ID`, checks the local binding and both required secret
   names, runs every suite and builds the pinned strict bundle. On the real upload Wrangler then
   inherits the staged secret bindings and refuses either missing one. The local gate and a dry run
   cannot prove that the remote values exist.

   Do not bypass this entrypoint with direct `wrangler deploy`, `wrangler versions upload` or
   `wrangler versions deploy`. The version-only commands cannot apply the pending Durable Object
   lifecycle migrations. A normal Wrangler deploy switches the Worker version before reconciling
   its route and cron triggers, so success is provisional until the live read-back below. If trigger
   reconciliation fails, do not set the webhook; review the live state and repeat the supported
   deploy after correcting the cause.

6. **Read back the deployed state, then set the webhook.** Confirm the deployed version, both secret
   names, the `SESSIONS`, `TAPE` and `WATCH` bindings, both applied migration tags, the exact API
   route, the cron trigger, and that the API Worker's `workers.dev` endpoint and preview URLs are
   disabled. From the repository root, exercise `npm run smoke:production` before connecting Telegram.

   If `site/token.json` still has a null address, stop here and leave the Worker deployed but its Telegram webhook
   disconnected. The public page promises that the bot stays off until a verified token address exists. Activate it
   only after that non-null address has been independently verified, published, and reproduced by the production
   smoke.

   Only then set the webhook to `https://chain.lintcha.com/api/telegram`, with the same secret in
   `secret_token`. Before contacting Telegram, the owned helper independently reads the fixed production
   `https://chain.lintcha.com/token.json` with a hard deadline, byte ceiling, no redirects and no cache;
   a null, malformed or unavailable activation document is a hard stop. The helper fixes the webhook URL,
   requests only `message` and `edited_message`, and explicitly keeps pending updates. It accepts both
   credentials only through masked TTY prompts; do not put either one in argv, environment variables or files.

        npm run telegram:set-webhook
        npm run telegram:webhook-info

   The second command reports only safe status fields and whether Telegram's configured URL is
   exactly the production URL; it does not repeat a mismatched URL or `last_error_message`.
   To roll the webhook back while preserving queued updates:

        npm run telegram:delete-webhook

   The delete mode asks for an additional interactive `DELETE` confirmation, reads the current
   webhook first, and deletes only when its URL is exactly the production URL. No configured
   webhook is a safe no-op; a foreign URL fails closed and remains untouched.

   These commands call the [official Bot API webhook methods](https://core.telegram.org/bots/api#getting-updates)
   with bounded responses and deadlines and refuse redirects. They do not store credentials; the
   Bot API necessarily uses the token in its HTTPS request path only inside the running process.

   BotFather checklist before that manual step:

   - keep adding the bot to groups enabled; confirm in Telegram that `@lintchabot` is actually a
     member of `@lintcha` and may send there, because `telegram:discover` cannot prove either fact;
   - leave [privacy mode](https://core.telegram.org/bots/features#privacy-mode) enabled. The current
     room path needs addressed commands and the bot's own join service message, both delivered in
     privacy mode; it neither needs every human message nor administrator status;
   - confirm `lintchabot` in BotFather is the username intended for this Worker;
   - keep the token only in the `TELEGRAM_BOT_TOKEN` secret and the webhook secret only in
     `TELEGRAM_WEBHOOK_SECRET`, never in `wrangler.toml`;
   - after setting the webhook, test one unsuffixed direct command, this bot's suffixed command
     in the room, and a command suffixed for another bot (which must receive no reply).

7. **Verify live Cloudflare controls by hand.** The `HOLD_PER_SECOND` bucket is restart-local and
   per isolate; it is a courtesy work bound, not security admission control. Put a dashboard-level
   rate/admission rule in front of the production holder route, choosing and checking its exact
   threshold against the live account rather than copying an unverified number from this repository.
   In the same pass, verify the current plan's external-request allowance, both Durable Object
   bindings, the KV id, secrets, routes and applied migrations. The local predeploy check cannot see
   any of those live facts.

The on-chain project token address may remain null while the Worker is prepared and deployed. The handlers remain
covered against a `token.json` of three nulls and the feed sleeps, but the Telegram webhook stays disconnected to keep
the public launch promise. That dormant state is distinct from the two Telegram credentials, which are required before
the Worker deployment.

## The five routes

    POST /api/telegram   every update must carry X-Telegram-Bot-Api-Secret-Token matching
                         the secret. A wrong or missing header gets four hundred and one
                         with an empty body: no hint, no echo of what arrived. A valid positive
                         update_id is durably claimed before side effects; command effects and
                         response actions resume from durable state, and active work/unavailable state
                         gets a retryable five hundred and three rather than rerunning a mutation
    POST /api/hold       the holder check, posted by the /hold page on the site. Same
                         origin, JSON media type and a bounded body are required before a separate
                         courtesy limit can let the request touch Watch
    GET/HEAD /api/tail   versioned, block-aligned committed pages of the public launch tail: ranges,
                         counts and hashes only; no raw name, ticker, address or private holder data
    GET/HEAD /api/wall   the public, strict post-snapshot suffix: bounded self-declared name
                         and ticker only, with completeness metadata and a reproducible rows hash
    GET/HEAD /api/deployer   bounded retained watcher history for one public deployer address:
                             exact coverage, launch count and safe-to-display declarations only;
                             no token address or transaction

Anything else under `/api/` is four hundred and four. The site's own pages are untouched:
the route is `/api/*` and the root stays with the assets worker.

## The holder check

    1  /verify in a direct message
    2  the bot atomically writes a random mark and telegram id to Watch SQLite for fifteen minutes, and sends
       https://chain.lintcha.com/hold?t=<mark>
    3  the page connects an injected wallet and builds the signed bytes from the exact production
       origin, that link's one-time mark, and the sentence that says nothing moves
    4  POST /api/hold { t, address, signature }; the worker recovers the address from the
       signature itself and refuses when it does not match the one sent
    5  it reads balanceOf and compares with five hundred thousand
    6  session:<telegram id> -> the address, for three days, and the bot answers in the chat

This is a domain- and nonce-bound sentence, not one static reusable proof. Both the page and worker
assemble it from the pinned production origin `https://chain.lintcha.com` and the dynamic mark in
that `/verify` link. A signature from one origin or link therefore cannot be moved to another. The
mark is spent by an atomic SQLite take before signature and balance checks, not when the whole check
succeeds. A second or concurrent post carrying the same mark is refused whatever happened to the first.

`/forget` independently asks both stores to remove what belongs to that Telegram id: the wallet-address session
from KV and every saved rule from the Watch object's SQLite. The command is idempotent and still runs when the
site, token or chain cannot be read. Its four responses say which stores acknowledged the request; they never
turn an unconfirmed response into success. Workers KV can briefly serve an older cached value after deletion, so
the bot says that explicitly rather than promising instant global disappearance. A message already in flight
cannot be recalled. The session also expires on its own.

Only an injected wallet, `window.ethereum`. WalletConnect would need a wss relay in
`connect-src`, and `connect-src` is `'self'` in `site/_headers`, which is vendored from
lintcha and must not be edited. That is a decision for another round, not something to
work around.

## The feed

One Durable Object on SQLite, one instance.

    alarm()   first attempts one durable pending room line; with no backlog, reads the token's
              Transfer log from the last block it saw, queues the buys, counts the sells and
              sets the next alarm
    cron      once a minute, and only as a watchdog: if a round has not happened inside the
              window it wakes the object and says so in the room, because a silent gap reads
              as an absence of buys

The interval is a setting, `FEED_INTERVAL_MS`, and starts at twelve seconds. A shorter interval
increases alarm and write volume, so measure the deployed workload and current account limits
before tuning it. The cron is not the feed because one minute is the shortest configured beat here.

A buy is the venue sending tokens to a wallet. A sell is a wallet sending them back. An
ordinary wallet to wallet transfer is neither.

A factory-derived curve is accepted only from the complete static launch record whose own token
field exactly equals the address requested. Every address word must have canonical high bits;
token, curve and deployer must be nonzero; and both boolean words must be canonical. A zero pair is
the valid native-quote launch form, but it is not treated as an ERC-20 price venue. A plausible
record for another token therefore cannot redirect the feed or price path.

### Delivery ledgers

Room buys, feed-gap notices and private rule matches use durable ledgers. Tape renders and queues every
proved buy in one accepted finalized range before advancing the block cursor; it sends nothing inline
while reading the range. An oversized multi-block log result gets one bounded retry at its first block.
If that single block is still above the authored log ceiling, Tape records an explicit gap without
publishing a prefix as complete. Relevant transfer blocks must share one canonical log hash and match
their numbered finalized header before a buy or sell becomes a fact.

Each beat attempts at most one pending room line, whether buy or gap notice. Old failures rotate behind
untouched work, and a durable per-room window permits at most twenty attempts in sixty seconds. Tape
drains a remaining backlog before reading another range. A Telegram refusal therefore keeps the
rendered line pending without requiring an RPC replay. Completed-range buy dedupe rows and accepted
delivery rows are removed only after the `last_block` cursor write. A pending rule line survives
pruning of its tail row while the session that authorized it could still be live; without a live
session it is retired at that session's maximum lifetime. Its hit counter advances only after
Telegram accepts the send.

This is deliberately described as at-least-once, not exactly-once. Telegram can accept a message and
the Worker can fail before the local `sent` acknowledgement is durable; retrying that pending row can
then repeat the message. The ledgers close the ordinary refusal and chain-range replay cases without
pretending that an external-send/local-ack crash boundary can be made atomic.

Command responses use the same honest boundary. A response is accepted only when Telegram returns an
HTTP success whose bounded JSON body says `ok: true`. A definite refusal releases that action's lease
for a later webhook retry; a lost or malformed success response keeps the lease until expiry because
Telegram may already have posted the line. Multi-part responses resume at their durable next action.
Joining the bot to a room is classified as a runnable service update, so its greeting uses this same
dedupe and response path; unrelated updates are acknowledged without spending a user's command bucket.

### The price proves its units on chain

`VENUE_KIND = "v3"` selects one ABI shape; it supplies no figure, token address, decimal
scale or orientation. Before `/price` or `/me` can state a value, the worker reads exact
single-word `token0()` and `token1()` results from the venue, confirms that the address from
the site's `token.json` is exactly one of those two sides, and reads `decimals()` from both
tokens. The other side's address is printed as the unit of the quote. It then accepts
`slot0()` only as the complete seven-word v3 record with every field inside its ABI width.

An unreadable side, duplicate or zero token, pool that does not contain the launch token,
unreadable decimals, short or extra `slot0` record, or invalid field width produces no price.
There is intentionally no `PAIR_DECIMALS` or `TOKEN_IS_FIRST` setting: either value would be
a manually supplied input to a figure the bot promises to read itself. `FEED_VENUE` may name
a post-graduation venue, but that address earns no trust from being configured; the same
on-chain topology and ABI proof runs against it before a quote is accepted. An explicit malformed,
zero or whitespace-padded venue fails closed instead of silently falling back to the launch curve.

### Sells

Counted, shown in `/stats`, never posted to the room. **And `/start` says so out loud,
with the reason.** Both halves of that are the arrangement; neither is optional. A room
that only ever shows buys is a choice about which facts reach the reader, and this project
spends its whole front page arguing against making choices like that quietly.

## The engine is loaded, not copied

`site/launch.js` decides what counts as the same string: it folds a link, strips a dollar from a ticker,
skeletons a name, and hashes what comes out. It is vendored from lintcha, its hash is in `VENDOR.md`, and it is
what the page runs. The watcher counts with **that file**, imported by path, and there is no copy of any part of
it anywhere under `bot/`.

That is not tidiness. If the tail folded one link differently from the page, the site would print one answer
and the bot would send another, and nothing would notice until it mattered.

    the page          three script tags; the UMD's global branch; digest through crypto.subtle
    the collector     createRequire in tools/launch-collect.mjs; the require branch; digest through node crypto
    the index writer  the same, in tools/launch-index.mjs
    the watcher       bot/src/engine.js; whichever branch the bundler picks; the same sha256 either way

`site/launch.js` is a UMD factory, so which branch runs is the loader's decision. `bot/src/engine-globals.js`
puts the two vendored tables on the global object before the engine is imported, so the global branch finds
what it needs; on the require branch those two assignments are dead weight, which is the point — either way
nothing is edited.

**The one deploy-time consequence: this worker carries `nodejs_compat`.** On the require branch the vendored
file calls `require("crypto")` and `Buffer.from`, so the bundle needs the node builtins to resolve. No authored
Worker module under `bot/src/` imports a node builtin; local test and build tools may. If a future deliberate
Wrangler upgrade will not resolve the unprefixed name, the fix is an alias in `wrangler.toml`, written out in
the comment there, and never an edit to the vendored file.

`bot/test/engine_test.mjs` is the proof rather than this paragraph. It hashes `site/launch.js` and compares
against the hash read out of `VENDOR.md`; it loads the file a second time the way the page does, from its own
bytes with `self` handed in; and it puts a fixture set of launches through both and compares every normalized
value, every hash, every table entry and `check()` itself.

One thing the bundle carries twice, said out loud: `bot/src/keccak.js` and `tools/launch/keccak.mjs`. The
watcher decodes `getTokenInfo()` with `tools/launch/abi.mjs`, imported rather than copied for the same reason
the engine is, and that file imports the collector's keccak for one helper. `bot/test/keccak_test.mjs` compares
the two implementations, so they cannot drift.

## The watcher

A second Durable Object, separate from the feed so that one failing does not stop the other.

    alarm()   reads the pons factory's launch log from the last finalized block it saw, reads what each new launch calls
              itself, stores it as counted hashes, checks the rules, and drops an old row only after the
              published snapshot covers its block
    cron      once a minute, and only as a watchdog: it starts the object again after a stretch with no
              endpoint, when there was no alarm left to fire

    interval        WATCH_INTERVAL_MS, twelve seconds
    depth           WATCH_DEPTH_DAYS, seven days. This is an age floor, not proof of coverage: age alone
                    never deletes a row whose block is still after the published snapshot
    limiter         the vendored Gate, through bot/src/chain.js. The Worker sets its owned Gate to zero
                    within-call retries: the next durable beat retries without multiplying physical requests

While the endpoint cannot be reached there is **no alarm at all**. Not a short one, not a retrying one: none.
There is nothing readable, so there is nothing to schedule, and the cron is what tries again a minute later.

A gap in the watcher's reading is counted and shown in `/rules`, to the people it costs. It is not announced in
the room: the feed's gaps are announced there because a silent gap in a buy feed reads as an absence of buys,
and this one costs the holders with rules and nobody else.

## The tail, and why the snapshot is not replaced

The index the page reads is a snapshot: collected up to a block, written to a file, hashed, and rebuilt by a
command anyone can run. Two published things depend on that. The **Reproduce it** section prints the file's hash
and the command; the `never` list says that if the site computes something the repository cannot, the repository
is decoration. A live database whose range keeps moving cannot be rebuilt and compared, so replacing the
snapshot with one would quietly break both.

The watcher reads `launch-manifest.json` before the index or numbers file. It accepts those two files only when
their exact bytes match the manifest's digests, so a snapshot refresh cannot silently pair generations while files
or isolate caches are changing. Each response is streamed into one preallocated buffer and refused above the
authored four-megabyte runtime ceiling; the manifest itself has the smaller fixed contract ceiling.

So the snapshot stays exactly as it is and gets a tail.

    GET /api/tail
      { ok, tail_version, engine, watcher_started_block, watcher_started_at,
        coverage_from_block, from_block, to_block, watcher_to_block, current_watcher_to_block,
        page, page_limit, previous_page_commitment, page_commitment, more, next_cursor,
        collected_at, depth_days, snapshot_to_block, gap_blocks, launches_in_tail,
        launches_in_page, entries, hash, rows_hash, tables, launches }

    GET /api/tail?cursor=<next_cursor>

Version one is a bounded sequence of block-aligned pages. SQLite returns at most `page_limit + 1`
rows to find the next complete block boundary; it never materializes the retained suffix and slices it
afterward. A block that by itself cannot fit is a machine-readable `capacity` failure rather than a
partial block. The first page fixes `watcher_to_block`; every `next_cursor` is authenticated by the
Watch object, bound to that upper block, the snapshot boundary, watcher epoch and coverage boundary,
and carries the prior page commitment. A changed boundary returns `reset_required`, so pages from two
generations cannot be combined. `current_watcher_to_block` may move ahead while that fixed traversal is
being read. Successful pages retain the old safe property: their own `from_block..to_block`, table and
hash are complete and independently reproducible.

`tables` is the index's own shape, per namespace, counted hashes. `launches` is one row per launch: a block, a
date and its hashes, and nothing else — no address, no raw string, no handle. `rows_hash` commits that
ordered list; `page_commitment` commits it together with the counted-table hash, range, total and prior
page commitment. That is the rule
`tools/launch-index.mjs` enforces on the file the page reads, and `bot/test/tail_test.mjs` checks the tail's
whole answer with that file's own pattern. Pruning also selects and deletes only one bounded batch per beat;
it never loads every covered token merely because the published snapshot moved.

`depth_days` is the configured pruning age floor. The object may keep an older row when the published snapshot
has not yet covered its block; retaining a duplicate candidate is safer than deleting part of the live suffix.

`from_block` is the first block the tail covers, not the block after the snapshot's last one. When those differ
there is a hole, and `gap_blocks` says how wide it is instead of letting a reader assume the two ranges meet. A
numbers file that cannot be read leaves both `snapshot_to_block` and `gap_blocks` null, never zero.

Reproducing one page is two commands, and neither edits anything:

    node tools/launch-collect.mjs --from <from_block> --to <to_block> --out build/tail-range.json
    node bot/tools/verify-tail.mjs --in build/tail-range.json

The comparison is over the canonical text defined in `bot/src/tally.js` and used by both sides, so the tool does
not get to decide what equal means. When `more` is true, fetch `next_cursor`, collect exactly that page's
reported range, and pass the cursor to `verify-tail.mjs`; the tool verifies the page/row commitments and prints
the next command. The authenticated cursor and `previous_page_commitment` keep the verified pages in order.

Neither public endpoint replaces the page's static snapshot. The tail exists because the rules read it, and
the wall exposes only its complete public suffix. `connect-src 'self'` already covers this worker's own
`/api/`, so the vendored `site/_headers` needs no edit.

## The public wall

    GET /api/wall
      { ok: true, snapshot_to_block, gap_blocks, watcher_to_block, read_at, page_limit,
        mode, older_cursor, live_cursor, rows_hash, view_hash, rows: [{ name, ticker }] }

The wall is the strict suffix after `snapshot_to_block`. Rows are ordered by their stored block and log index,
but those coordinates stay internal: each public row has exactly the token's bounded, self-declared `name` and
`ticker`. `rows_hash` is SHA-256 of `JSON.stringify(rows)`, so a client can reproduce it from the response.
`read_at` is the watcher's saved last-round time, not the time the HTTP response happened to be built.

It fails closed with HTTP 503 and `{ ok: false, why }` when the published numbers are unreadable or invalid,
the watcher cursor or saved round time is invalid, the last round is stale, or the cursor is behind either the
snapshot boundary or the last head the watcher observed. A launch the watcher could not read blocks the wall
while its block is in the post-snapshot suffix; once a later published snapshot covers that block, it no longer
blocks the wall. A post-snapshot row written before wall metadata existed returns `backfill` instead of silently
disappearing. Retention likewise removes a row only when both its age floor has passed and the published
snapshot covers its block; an unreadable snapshot boundary keeps the row. Invalid, blank or overlong
declarations are omitted rather than trimmed, truncated or replaced with invented text.

## Public deployer history

    GET /api/deployer?address=<deployer address>
      { ok, address, from_block, to_block, read_at, launches_seen, page_limit,
        truncated, rows_hash, rows: [{ block, log_index, date, name, ticker }] }

This is retained watcher history, not an all-time wallet profile. Its range begins after the saved watcher boundary
and advances when an old covered prefix is pruned. The count includes every retained launch by that deployer inside
the stated range; the bounded page keeps the newest factory positions and returns them in chronology. `truncated`
says when the count is larger than the returned page. Unsafe declarations become `null`, never executable or
rewritten text, and `rows_hash` is SHA-256 of `JSON.stringify(rows)`.

`HISTORY_PAGE_ROWS` starts at two hundred rows. `HISTORY_PER_SECOND` starts at two requests per second and is used by
both the public route's per-isolate courtesy bucket and the singleton Watch object's restart-local bucket. The two
buckets are separate from `/api/tail`. Missing, stale, backlogged, unreadable or incompletely backfilled watcher state
fails closed instead of becoming an empty successful history.

## Rules

For holders, in a direct message, after `/verify`.

    /rule string SOLANA   a launch whose ticker, name or one of its five links is that string
    /rule dev 0x…         another launch from that deployer
    /rule shared <count>  a ticker already carried by that many launches or more
    /rules                your rules, and what the watcher has read
    /unrule <number>      drop one, by the number /rules gives it
    /unrule all           drop all of your saved rules without dropping the holder session

Not one of them carries a judgment. Three are string equality and the fourth is a count with a threshold the
person picked. There is no score, no probability, no ordering by anything but the order they were made in, and
no colour that means good or bad.

A string rule is stored as the hashes the engine gives its query, and a launch as the hashes the engine gave its
fields, so a match is hash equality between two things the same engine produced — the same operation the page
performs on a pasted launch. A `shared` rule's count comes from `check()`, the page's own entry point, run
against the index published on the site.

The published index has three answers about a value and a rule message gives three different sentences: it
carries an entry and the count is quoted; it carries none, which under its own count floor means fewer than the
floor rather than none; or it could not be read at all, which is a network fault and not a fact. A `shared` rule
does not fire on a count it could not read.

Rules live in the watcher's SQLite rather than in KV, because they are read against every new launch and that is
work for the store next to the data. They belong to a Telegram id and can outlive an expired session, but `/forget`
removes them all; a rule only ever fires while a session is live, because a lapsed session is somebody who may no
longer hold. `RULES_PER_HOLDER` is the limit.

`/rules` keeps every stable `/unrule` number and splits the list into explicitly numbered
messages before Telegram's text ceiling. If one send is transiently refused, the sender still
attempts every later part; its `page N of M` header makes the missing part visible instead of
silently making the remaining list look complete.

`/unrule` takes the number `/rules` gave, resolved inside the sender's own list, and the delete carries the owner
in its where clause. Another person's rule is unreachable twice over. `/unrule all` uses the same owner-scoped
delete as `/forget`, but leaves the holder session alone.

## What the page had to say before any of this

`token.p1` promised, word for word, that holding `$LINTCHA` buys *no extra check, no earlier data and no private
index*. The middle third of that stops being true the second the bot writes to a holder about a launch before
the snapshot shows it. The line is replaced in the same round, in all three languages, and the replacement says
out loud what holding does buy:

> A holder can ask the bot to watch the log and write when a string they named appears; the check it runs is the
> one on this page, and the index it reads is the one published here.

`never` line two — *no private index and no paid tier that reads more than this page reads* — stays true, and
the code is what keeps it true: a rule reads `launch-index.json`, the file the page reads, over the network,
like anyone else.

## What the bot never does

- It never messages anyone first.
- It never asks for a key, a seed or an approval to spend.
- It never holds funds and never trades.
- The check signs a sentence, with no gas, and the sentence says in words that it moves
  nothing.
- It sets no score, predicts nothing and advises nothing.
- Everything it says is read from the chain.

That last one is load bearing rather than decorative: it is why there is no price API in
here and why there will not be one. A dollar figure from a third party would make the
sentence false. A price is quoted only after the venue names the launch token on one side,
names the paired token on the other, supplies both decimal scales and returns the complete
known pool record. When any of that cannot be read the bot says it cannot instead of printing
a number.

## Tests

    npm test --prefix bot

`package.json` names every `*_test.mjs` explicitly, including the nonce, wall and history suites, so adding a
file does not make it run by accident. None uses the live network: the site responses, RPC endpoint,
Telegram, KV and both Durable Object contexts are local fakes from `test/fakes.mjs`.

    keccak_test    published digests, the selectors every wallet agrees on, and a comparison
                   against tools/launch/keccak.mjs so the two keccaks in this tree cannot drift
    nonce_test     the Watch SQLite nonce, webhook response/effect and dedupe tables: canonical
                   marks, expiry, one-time take, durable command replay, leases and concurrent claims
    verify_test    recovery from a signature, another origin or mark, an altered sentence, another
                   address, the atomic nonce adapter, and the threshold at exactly five hundred
                   thousand and one unit below
    router_test    every command answers, an unknown one is silent, and with three null on
                   the site nothing prints an address, a zero or a dash
    webhook_test   bounded webhook parsing, fail-closed durable update claims, concurrent/render/send
                   leases, response-store recovery, idempotent rule and nonce effects, room greeting,
                   method refusals, and /api/hold failures through the same atomic nonce path
    telegram_bootstrap_test   offline getMe/getChat identity binding, masked and bounded TTY input,
                   fail-closed fixed-production token activation, redirect refusal, strict bounded
                   HTTP responses, exact webhook payloads, guarded deletion, safe output and
                   checked-in BOT_USERNAME agreement
    chain_test     the site's file, the minute long cache, zero within-call RPC retries, exact
                   scalar/record/log reads, token-bound factory records, header-bound transfers,
                   chain-proved pool sides and decimals, and failures that are null rather than invented
    tape_test      no alarm while the address is null, proved buys and sells, explicit overflow gaps,
                   bounded fair buy/gap delivery, finalized cursor identity and refusal recovery
    texts_test     the section-eight prose, invariant-safe command list, the sells paragraph in /start, the signed
                   origin, mark and sentence identical in bot/src/texts.js and site/hold/hold.js,
                   and no retry button after a one-time mark was spent
    predeploy_test the local deployment gate refuses the placeholder, missing or empty SESSIONS id,
                   missing required secret names, public Worker aliases and an invalid BotFather username;
                   production mode also refuses an empty or malformed Telegram room id without claiming
                   to verify live resources
    engine_test    the round's main test: site/launch.js hashed against VENDOR.md's own row,
                   loaded a second time the way the page loads it, and one fixture set through
                   both engines compared value for value, hash for hash, entry for entry, and
                   through check() itself
    rules_test     a string rule fires on a match and is otherwise silent, a dev rule on that
                   deployer and no other, a shared rule at the threshold and not one below,
                   and one person's rule is not removable by another
    watch_test     no alarm while there is no endpoint, a launch stored once, one that will
                   not read neither written half nor stepped over, an old snapshot-covered row
                   dropped, and a durable rule line retried before its hit is counted
    tail_test      no address or raw string; >1000-row block-aligned paging, authenticated cursor
                   tamper/staleness/order, reproducible row/table/page commitments, bounded SQL,
                   interleaved state fencing, batched pruning, route caching and failure passthrough
    wall_test      exact public keys and row shape, strict snapshot boundary, block/log ordering,
                   JSON escaping, reproducible rows hash, cache and rate limits, plus fail-closed
                   snapshot, watcher, unreadable-suffix, backfill and retention cases
    history_test   exact retained coverage and public row shape, bounded newest-page behavior,
                   reproducible rows hash, independent route/object limits and fail-closed watcher states
    rules_router_test   the three commands end to end, from a message with no session to a
                   stored rule and back, including the longest legal list split into bounded,
                   numbered messages and continued delivery after one transient send failure

The byte comparison in `texts_test` matters more than it looks. There is no build step under `site/`, so
nothing else keeps those two message constructions together, and one different space would mean
the worker recovers a stranger and refuses an honest holder.

## Two files under site/ belong to this work

    site/hold/index.html   the signature page, static
    site/hold/hold.js      its script, external because the vendored CSP carries one inline hash

`tools/verify-vendor.mjs` walks `site/ src/ tests/ tools/` and reports any file there that
is neither in the vendor table nor in the owned here list. Both of these are in the owned
here list, added by whoever owns `VENDOR.md` when round D1 landed.

The watcher adds nothing to any of those four directories, which is why
`bot/tools/verify-tail.mjs` lives under `bot/` rather than in `tools/` beside the collector
it drives. `VENDOR.md` is not edited by this work either, and needs no row for it.
