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
    test/*.mjs        seven files, no network in any of them

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
    5  it reads balanceOf and compares with one million
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

Seven files, no network in any of them. The site, the endpoint, Telegram, the store and the
Durable Object's context are all objects in `test/fakes.mjs`.

    keccak_test    published digests, the selectors every wallet agrees on, and a comparison
                   against tools/launch/keccak.mjs so the two keccaks in this tree cannot drift
    verify_test    recovery from a signature, an altered sentence, another address, the one
                   time mark, and the threshold at exactly a million and one unit below
    router_test    every command answers, an unknown one is silent, and with three null on
                   the site nothing prints an address, a zero or a dash
    webhook_test   the wrong header is four hundred and one with an empty body
    chain_test     the site's file, the minute long cache, and a failed read that is null
                   rather than zero
    tape_test      no alarm while the address is null, a buy posted, a sell only counted
    texts_test     section eight word for word, the sells paragraph in /start, and the signed
                   sentence identical in bot/src/texts.js and site/hold/hold.js

The last one matters more than it looks. There is no build step under `site/`, so nothing
else keeps those two copies of the sentence together, and one different space would mean
the worker recovers a stranger and refuses an honest holder.

## Two files under site/ belong to this work

    site/hold/index.html   the signature page, static
    site/hold/hold.js      its script, external because the vendored CSP carries one inline hash

`tools/verify-vendor.mjs` walks `site/ src/ tests/ tools/` and reports any file there that
is neither in the vendor table nor in the owned here list. These two are new, so it will
name them until `VENDOR.md` gains two rows. `VENDOR.md` is not edited by this work.
