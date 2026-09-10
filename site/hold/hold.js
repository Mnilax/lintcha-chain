// The /hold page's script. An external file on purpose: site/_headers is vendored and its script-src carries
// 'self' plus one inline hash, so a second inline script would be blocked without a word in the console the
// page could act on. Classic script, no modules and no imports, because it is served straight from site/ with
// no build step of any kind.
//
// It does three things and nothing else: ask the injected wallet who it is, ask it to sign one sentence, and
// post the result to /api/hold on this same origin. It never reads a key, never asks for one, and never sends
// anything anywhere else.
//
// Only window.ethereum. WalletConnect would need a wss relay in connect-src, and connect-src is 'self' in a
// vendored file that must not be edited. That is a decision for another round, not a thing to work around here.
(function () {
  "use strict";

  // THE SENTENCE. It must match bot/src/texts.js SENTENCE character for character: the worker recovers the
  // address from this exact string, and one different space would recover a stranger. bot/test/hold_page_test.mjs
  // reads both files and fails when they drift, because there is no build step here to keep them together.
  var SENTENCE = "I am proving to the lintcha bot that this wallet is mine. This signature moves nothing, approves nothing and spends nothing.";

  var connectBtn = document.querySelector("[data-connect]");
  var signBtn = document.querySelector("[data-sign]");
  var walletOut = document.querySelector("[data-wallet]");
  var stateOut = document.querySelector("[data-state]");
  var sentenceOut = document.querySelector("[data-sentence]");
  var account = null;

  sentenceOut.textContent = SENTENCE;

  function say(text, tone) {
    stateOut.textContent = text;
    if (tone) stateOut.setAttribute("data-tone", tone); else stateOut.removeAttribute("data-tone");
  }

  function markOf() {
    var m = /[?&]t=([0-9a-fA-F]{8,64})(?:&|$)/.exec(window.location.search || "");
    return m ? m[1].toLowerCase() : null;
  }

  var mark = markOf();
  if (!mark) {
    say("This link is missing its one time mark, so there is nothing for me to check. Send /verify to the bot again and open the link it gives you.", "bad");
    connectBtn.disabled = true;
    return;
  }

  function provider() {
    return typeof window.ethereum === "undefined" ? null : window.ethereum;
  }

  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4); };

  // the message goes over as hex, so there is no argument about how the wallet reads the string
  function hexOf(s) {
    var bytes = new TextEncoder().encode(s), out = "0x";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  connectBtn.addEventListener("click", function () {
    var eth = provider();
    if (!eth) {
      say("I cannot see a wallet in this browser. Open this link in the browser your wallet is installed in, or in the wallet's own browser. This page only talks to an injected wallet.", "bad");
      return;
    }
    connectBtn.disabled = true;
    say("Waiting for the wallet to say which account it is.");
    eth.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      if (!accounts || !accounts.length) {
        connectBtn.disabled = false;
        say("The wallet gave no account back, so there is nothing to check yet.", "bad");
        return;
      }
      account = String(accounts[0]).toLowerCase();
      walletOut.textContent = short(account);
      signBtn.disabled = false;
      connectBtn.textContent = "Connected";
      say("Now sign the sentence. It moves nothing.");
    }).catch(function () {
      connectBtn.disabled = false;
      say("The wallet turned that down, so nothing happened. Press connect again when you are ready.", "bad");
    });
  });

  signBtn.addEventListener("click", function () {
    var eth = provider();
    if (!eth || !account) return;
    signBtn.disabled = true;
    say("Waiting for the signature.");
    eth.request({ method: "personal_sign", params: [hexOf(SENTENCE), account] }).then(function (signature) {
      say("Signed. Reading the balance from the chain.");
      return fetch("/api/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: mark, address: account, signature: signature })
      });
    }).then(function (r) {
      if (!r) return;
      return r.json().then(function (body) { return { status: r.status, body: body }; }, function () { return { status: r.status, body: null }; });
    }).then(function (res) {
      if (!res) return;
      if (res.body && res.body.ok) {
        say("Checked. That wallet holds enough, and the bot has answered in the chat you came from. You can close this page.");
        signBtn.textContent = "Done";
        return;
      }
      var why = res.body && res.body.why;
      if (why === "below") say("That wallet does not hold one million $LINTCHA, so I did not open a session. Nothing was stored.", "bad");
      else if (why === "signature") say("The signature does not belong to the account it came with, so I did not read a balance. Send /verify for a fresh link.", "bad");
      else if (why === "nonce") say("This link is used or expired. Send /verify to the bot for a new one.", "bad");
      else if (why === "unreadable") say("I could not read the chain just now, so I will not guess. Try the same link again in a moment.", "bad");
      else say("That did not go through. Send /verify to the bot for a fresh link.", "bad");
      signBtn.disabled = why === "nonce";
    }).catch(function () {
      signBtn.disabled = false;
      say("The wallet turned the signature down, or the request did not go through. Nothing moved either way.", "bad");
    });
  });
})();
