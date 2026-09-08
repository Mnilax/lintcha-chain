// lintcha launch identity (LINTCHA_12): the link alias table for I1, in one file, one fold per line. Only what is
// mechanically the same resource: a platform's second and mobile hosts, and a bare handle in a field that names its
// platform. For hosts in this table the path is lowercased (one account, one case); everywhere else the path keeps
// its case. Link shorteners and redirects are never folded: expanding one is a network call, and the page makes
// none. Every row is covered by tests/launch_test.js with a pair that folds and a pair that must stay apart.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LaunchLinks = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // host as written (after the leading "www." is gone) -> the host it stands for
  var HOSTS = {
    "twitter.com": "x.com",            // twitter.com        -> x.com
    "mobile.twitter.com": "x.com",     // mobile.twitter.com -> x.com
    "m.twitter.com": "x.com",          // m.twitter.com      -> x.com
    "mobile.x.com": "x.com",           // mobile.x.com       -> x.com
    "x.com": "x.com",                  // x.com stays, and takes the lowercase path
    "telegram.me": "t.me",             // telegram.me        -> t.me
    "telegram.dog": "t.me",            // telegram.dog       -> t.me
    "t.me": "t.me"                     // t.me stays, and takes the lowercase path
  };
  // a field that names its platform: a bare handle in it is that platform's page
  var PLATFORM = {
    "twitter": "x.com",                // socials.twitter  = "@bob" -> x.com/bob
    "telegram": "t.me"                 // socials.telegram = "@bob" -> t.me/bob
  };
  // what a bare handle looks like: an optional @, then letters, digits, underscore; no dot, no slash, no space
  var HANDLE = /^@?([a-z0-9_]{1,64})$/i;
  return { HOSTS: HOSTS, PLATFORM: PLATFORM, HANDLE: HANDLE };
});
