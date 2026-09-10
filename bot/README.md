# bot

The room's half of lintcha. It reads the chain and answers, and it does nothing else.

The code is here because the page already promises it is. The roadmap on
`chain.lintcha.com` carries this sentence in production:

> Everything the bot says is read from the chain, and its code ships in this repository
> with the rest.

So it ships here, in its own folder with its own `wrangler.toml`, so that the site's
config and the bot's config cannot disturb each other.

## What is in here

    wrangler.toml     the worker: name, routes, bindings, the migration, the cron, the settings
    package.json      type module, and the test script. Nothing is installed: there are no dependencies
    src/index.js      the worker. Two routes and a cron, and nothing else answers
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
    test/*.mjs        twelve files, no network in any of them

## The limiter is vendored, not written

`src/rpc.js` is `tools/launch/rpc.mjs` copied byte for byte. Same class, same two in
flight, same six hundred milliseconds between starts and fifteen hundred for `eth_getLogs`,
same doubling wait on a four hundred and twenty-nine, same user agent. It is not edited and
it must not be: the endpoint's edge refuses anonymous library signatures, and the collector
already found the settings that work.

    source     tools/launch/rpc.mjs
    sha256     d916e49c10f6fff56f43255fb799a54986e0fe719d03df231e1344e837f2152a
    identical  yes, byte for byte, and that hash is the one VENDOR.md records for the source

There is one RPC client in this repository and this is a copy of it. A second one is not
written here, and `src/chain.js` puts every call through this Gate.

## The address is the site's, and only the site's

The bot does not store the token address. It reads
`https://chain.lintcha.com/token.json` and keeps the answer in the isolate's memory for
at most a minute.

That is the whole point of the arrangement: **on the day of the launch, the same one file
edit that lights the acid band on the page turns the bot on.** There is no second place
for the address to disagree with the site.

While `address` is null:

    /ca /price /me /verify /top /stats   say the token does not exist yet
    the feed                             does not start, and no alarm is set at all

A site that cannot be read is a third state with its own sentence. It is never collapsed
into "there is no token", because that would be telling somebody a fact about the token
when what actually happened was a network fault.

## Setting it up

1. **A KV namespace** called `lintcha-chain-sessions`, bound as `SESSIONS`. Put its id in
   `wrangler.toml`, replacing the placeholder. Two kinds of key ever live in it, both with
   their own expiry:

        nonce:<random>      -> the telegram id that asked        fifteen minutes
        session:<tg id>     -> the address that signed           three days

   Nothing else is written there: no purchase history, no signatures, no addresses of
   people who failed, no IP. The expiry does the deleting, so there is no sweeper to write.

2. **Two secrets**, with `wrangler secret put`, never as variables: a variable is readable
   in the dashboard in plain text.

        TELEGRAM_BOT_TOKEN        the bot's token
        TELEGRAM_WEBHOOK_SECRET   a long random string

3. **The room's chat id** in `ROOM_CHAT_ID`. Until it is set the feed still records buys
   and posts nothing, which is the right way round: no chat id must never mean no records.

4. **Deploy** from this folder. The migration creates the `Tape` object on SQLite, which a
   new class has to be.

5. **Set the webhook** to `https://chain.lintcha.com/api/telegram`, with the same secret in
   `secret_token`. That command carries the bot token, so it is not written in this file,
   not in the report and not anywhere in this repository.

Nothing here needs the token to exist. Deploy it against a `token.json` of three nulls and
every command answers correctly; the feed sleeps.

## The two routes

    POST /api/telegram   every update must carry X-Telegram-Bot-Api-Secret-Token matching
                         the secret. A wrong or missing header gets four hundred and one
                         with an empty body: no hint, no echo of what arrived
    POST /api/hold       the holder check, posted by the /hold page on the site. Same
                         origin, which is why the vendored connect-src 'self' needed no edit

Anything else under `/api/` is four hundred and four. The site's own pages are untouched:
the route is `/api/*` and the root stays with the assets worker.

## The holder check

    1  /verify in a direct message
    2  the bot writes nonce:<random> -> telegram id, for fifteen minutes, and sends
       https://chain.lintcha.com/hold?t=<mark>
    3  the page connects an injected wallet and signs one sentence
    4  POST /api/hold { t, address, signature }; the worker recovers the address from the
       signature itself and refuses when it does not match the one sent
    5  it reads balanceOf and compares with five hundred thousand
    6  session:<telegram id> -> the address, for three days, and the bot answers in the chat

The mark is spent when it is looked up, not when the check succeeds. A second post carrying
the same mark is refused whatever happened the first time.

`/forget` drops the session in one call. It also expires on its own.

Only an injected wallet, `window.ethereum`. WalletConnect would need a wss relay in
`connect-src`, and `connect-src` is `'self'` in `site/_headers`, which is vendored from
lintcha and must not be edited. That is a decision for another round, not something to
work around.

## The feed

One Durable Object on SQLite, one instance.

    alarm()   reads the token's Transfer log from the last block it saw, posts the buys to
              the room, counts the sells, sets the next alarm
    cron      once a minute, and only as a watchdog: if a round has not happened inside the
              window it wakes the object and says so in the room, because a silent gap reads
              as an absence of buys

The interval is a setting, `FEED_INTERVAL_MS`, and starts at twelve seconds. That is about
seven thousand two hundred wake ups a day, near seven per cent of the free plan's daily
write limit. The cron is not the feed because one minute is the shortest cron Cloudflare
accepts.

A buy is the venue sending tokens to a wallet. A sell is a wallet sending them back. An
ordinary wallet to wallet transfer is neither.

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
file calls `require("crypto")` and `Buffer.from`, so the bundle needs the node builtins to resolve. Nothing
written in `bot/` imports a node builtin. If a wrangler version will not resolve the unprefixed name, the fix is
an alias in `wrangler.toml`, written out in the comment there, and never an edit to the vendored file.

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

    alarm()   reads the pons factory's launch log from the last block it saw, reads what each new launch calls
              itself, stores it as counted hashes, checks the rules, drops anything older than the depth
    cron      once a minute, and only as a watchdog: it starts the object again after a stretch with no
              endpoint, when there was no alarm left to fire

    interval        WATCH_INTERVAL_MS, twelve seconds
    depth           WATCH_DEPTH_DAYS, seven days. Older than that is inside the snapshot's window already
    limiter         the vendored Gate, through bot/src/chain.js. There is one RPC client in this repository

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

So the snapshot stays exactly as it is and gets a tail.

    GET /api/tail
      { engine, from_block, to_block, collected_at, depth_days, snapshot_to_block, gap_blocks,
        launches_in_tail, entries, hash, tables, launches }

`tables` is the index's own shape, per namespace, counted hashes. `launches` is one row per launch: a block, a
date and its hashes, and nothing else — no address, no raw string, no handle. That is the rule
`tools/launch-index.mjs` enforces on the file the page reads, and `bot/test/tail_test.mjs` checks the tail's
whole answer with that file's own pattern.

`from_block` is the first block the tail covers, not the block after the snapshot's last one. When those differ
there is a hole, and `gap_blocks` says how wide it is instead of letting a reader assume the two ranges meet. A
numbers file that cannot be read leaves both `snapshot_to_block` and `gap_blocks` null, never zero.

Reproducing it is two commands, and neither edits anything:

    node tools/launch-collect.mjs --from <from_block> --to <to_block> --out build/tail-range.json
    node bot/tools/verify-tail.mjs --in build/tail-range.json

The comparison is over the canonical text defined in `bot/src/tally.js` and used by both sides, so the tool does
not get to decide what equal means.

The page is not touched in this round. It still reads the static file; the tail is here because the rules read
it. `connect-src 'self'` already covers this worker's own `/api/`, so the vendored `site/_headers` needs no
edit.

## Rules

For holders, in a direct message, after `/verify`.

    /rule string SOLANA   a launch whose ticker, name or one of its five links is that string
    /rule dev 0x…         another launch from that deployer
    /rule shared <count>  a ticker already carried by that many launches or more
    /rules                your rules, and what the watcher has read
    /unrule <number>      drop one, by the number /rules gives it

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
work for the store next to the data. They belong to a telegram id and outlive the session that was needed to
make one — but a rule only ever fires while that session is live, because a lapsed session is somebody who may
no longer hold. `RULES_PER_HOLDER` is the limit.

`/unrule` takes the number `/rules` gave, resolved inside the sender's own list, and the delete carries the owner
in its where clause. Another person's rule is unreachable twice over.

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
sentence false. Prices are quoted in whatever token the launch paired against, and when
that cannot be read the bot says it cannot instead of printing a number.

## Tests

    npm test --prefix bot

Twelve files, no network in any of them. The site, the endpoint, Telegram, the store and both
Durable Objects' contexts are all objects in `test/fakes.mjs`.

    keccak_test    published digests, the selectors every wallet agrees on, and a comparison
                   against tools/launch/keccak.mjs so the two keccaks in this tree cannot drift
    verify_test    recovery from a signature, an altered sentence, another address, the one
                   time mark, and the threshold at exactly five hundred thousand and one unit below
    router_test    every command answers, an unknown one is silent, and with three null on
                   the site nothing prints an address, a zero or a dash
    webhook_test   the wrong header is four hundred and one with an empty body
    chain_test     the site's file, the minute long cache, and a failed read that is null
                   rather than zero
    tape_test      no alarm while the address is null, a buy posted, a sell only counted
    texts_test     section eight word for word, the sells paragraph in /start, and the signed
                   sentence identical in bot/src/texts.js and site/hold/hold.js
    engine_test    the round's main test: site/launch.js hashed against VENDOR.md's own row,
                   loaded a second time the way the page loads it, and one fixture set through
                   both engines compared value for value, hash for hash, entry for entry, and
                   through check() itself
    rules_test     a string rule fires on a match and is otherwise silent, a dev rule on that
                   deployer and no other, a shared rule at the threshold and not one below,
                   and one person's rule is not removable by another
    watch_test     no alarm while there is no endpoint, a launch stored once, one that will
                   not read neither written half nor stepped over, everything past the depth
                   dropped, and a rule that fires for a live session and not for a lapsed one
    tail_test      the answer carries no address and no raw string, by the index writer's own
                   pattern; its hash is a function of its table and of nothing else; and the
                   route caches, limits and answers four hundred and four beside itself
    rules_router_test   the three commands end to end, from a message with no session to a
                   stored rule and back

The last one of the first seven matters more than it looks. There is no build step under `site/`, so nothing
else keeps those two copies of the sentence together, and one different space would mean
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
