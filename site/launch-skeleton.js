// lintcha launch identity (LINTCHA_12): the skeleton table for N3, in one file, one fold per line.
// A skeleton is taken from the lowercased, NFKD-decomposed string: MARKS are removed, then every character is looked
// up in CHARS (absent characters stay as they are), then PAIRS are folded left to right. Two strings that differ as
// strings and agree as skeletons are a lookalike. Every row below is covered by tests/launch_test.js with a pair
// that folds and a pair that must not. Non-ascii characters are written as escapes so that a reader sees the code
// point and not a glyph that looks like another one.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LaunchSkeleton = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var CHARS = {
    "0": "o",                         // 0 O o        -> o   (O is already o after lowercasing)
    "1": "l", "i": "l", "|": "l",     // 1 l I i |    -> l   (I is already i after lowercasing)
    "5": "s",                         // 5 S s        -> s
    "2": "z",                         // 2 Z z        -> z
    "8": "b",                         // 8 B          -> b
    "\u0430": "a",                    // cyrillic a   -> a
    "\u0435": "e",                    // cyrillic e   -> e
    "\u043e": "o",                    // cyrillic o   -> o
    "\u0440": "p",                    // cyrillic r   -> p
    "\u0441": "c",                    // cyrillic s   -> c
    "\u0445": "x",                    // cyrillic h   -> x
    "\u0443": "y",                    // cyrillic u   -> y
    "\u043a": "k",                    // cyrillic k   -> k
    "\u043c": "m",                    // cyrillic m   -> m
    "\u043d": "h",                    // cyrillic n   -> h
    "\u0442": "t",                    // cyrillic t   -> t
    "\u0432": "b"                     // cyrillic v   -> b
  };
  var PAIRS = [
    ["rn", "m"],                      // rn -> m
    ["vv", "w"]                       // vv -> w
  ];
  // removed outright: combining marks (what NFKD leaves after a letter), zero-width space, joiner and non-joiner,
  // word joiner, byte order mark, soft hyphen
  var MARKS = /[\u0300-\u036f\u200b-\u200d\u2060\ufeff\u00ad]/g;
  return { CHARS: CHARS, PAIRS: PAIRS, MARKS: MARKS };
});
