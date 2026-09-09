// lintcha-chain visualizations, computed at build time from the shipped index (site/launch-index.json) and nothing
// else. Two kinds, and the line between them is absolute (LINTCHA_CHAIN_04, "Visualizations"): a chart has an axis, a
// scale, labels and figures, and every one of those comes from the index; the ornament has no axis, no scale, no label
// and no figure, and cannot be mistaken for a chart. Node standard library only, no dependency.
//
//   charts(index, numbers, t)   the three real charts as HTML: launches per shared ticker (n over the ticker namespace),
//                               lookalike groups by spellings (v over ticker_skeleton, v >= 2), deployers per shared link
//                               (d over the link namespace). Bucket labels and counts are written here from the data, so
//                               a digit in them arrives by substitution from the index, never from a template or a string.
//   ornament()                  a grid of mono glyphs drifting in opacity, drawn from a fixed pattern: nothing in it is
//                               read from any data, and it says so on its badge.
//
// Every sentence a chart carries (its caption) is an i18n string filled with figures from the same distribution, so the
// caption can never disagree with the bars under it.
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// the buckets are the mock's: single values up to five, then widening bands, then a hundred and more
export const COUNT_BUCKETS = [[2, 2], [3, 3], [4, 4], [5, 5], [6, 7], [8, 11], [12, 19], [20, 49], [50, 99], [100, Infinity]];
export const DEPLOYER_BUCKETS = [[1, 1]].concat(COUNT_BUCKETS);
export const SPELLING_BUCKETS = [[2, 2], [3, 3], [4, Infinity]];

const label = ([a, b], t, kind) => {
  if (b === Infinity) return kind === "v" ? t("viz.look.more", { v: a }) : t("viz.bucket.more", { n: a });
  if (a === b) return kind === "v" ? t("viz.look.row", { v: a }) : String(a);
  return t("viz.bucket.range", { a, b });
};

export function histogram(entries, key, buckets) {
  const out = buckets.map(() => 0);
  for (const e of entries) { const x = e[key]; const i = buckets.findIndex(([a, b]) => x >= a && x <= b); if (i >= 0) out[i]++; }
  return out;
}

// the distributions and the figures the captions need, all from the index
export function measure(index) {
  const ticker = Object.values(index.ticker), link = Object.values(index.link);
  const tsk = Object.values(index.ticker_skeleton).filter(e => e.v >= 2), nsk = Object.values(index.name_skeleton).filter(e => e.v >= 2);
  const tickerHist = histogram(ticker, "n", COUNT_BUCKETS), linkHist = histogram(link, "d", DEPLOYER_BUCKETS), lookHist = histogram(tsk, "v", SPELLING_BUCKETS);
  const maxTicker = ticker.reduce((a, e) => (a === null || e.n > a.n ? e : a), null);
  const maxLink = link.reduce((a, e) => (a === null || e.d > a.d ? e : a), null);
  const modeIdx = tickerHist.indexOf(Math.max(...tickerHist));
  return {
    ticker: { entries: ticker.length, hist: tickerHist, max_n: maxTicker ? maxTicker.n : 0, max_d: maxTicker ? maxTicker.d : 0, max_ties: maxTicker ? ticker.filter(e => e.n === maxTicker.n).length : 0, mode_bucket: COUNT_BUCKETS[modeIdx], mode_count: tickerHist[modeIdx] },
    look: { groups: Object.keys(index.ticker_skeleton).length, lookalike: tsk.length, hist: lookHist, largest_v: tsk.length ? Math.max(...tsk.map(e => e.v)) : 0, name_lookalike: nsk.length, name_largest_v: nsk.length ? Math.max(...nsk.map(e => e.v)) : 0 },
    link: { entries: link.length, hist: linkHist, single_deployer: linkHist[0], max_d: maxLink ? maxLink.d : 0, max_n: maxLink ? maxLink.n : 0, max_ties: maxLink ? link.filter(e => e.d === maxLink.d).length : 0 }
  };
}

function bars(hist, buckets, t, kind, nf, wide) {
  const max = Math.max(...hist, 1);
  return hist.map((c, i) => {
    const pct = c === 0 ? 0 : Math.max(0.05, (c / max) * 100);
    const bar = c === 0 ? "" : `<span class="chart-bar" data-bar style="width:${pct.toFixed(2)}%"></span>`;
    return `<div class="chart-row${wide ? " chart-row-wide" : ""}"><span class="chart-key">${esc(label(buckets[i], t, kind))}</span><span class="chart-track">${bar}</span><span class="chart-val${c === 0 ? " chart-val-zero" : ""}">${nf.format(c)}</span></div>`;
  }).join("");
}

function card(title, badge, caption, rows, xLabel, yLabel) {
  return `<div class="chart" data-chart>
  <div class="chart-head"><h3 class="chart-title">${esc(title)}</h3><span class="badge badge-snapshot">${esc(badge)}</span></div>
  ${caption ? `<p class="chart-caption">${esc(caption)}</p>` : ""}
  <div class="chart-rows">${rows}</div>
  <div class="chart-axis"><span>${esc(xLabel)}</span><span>${esc(yLabel)}</span></div>
</div>`;
}

// t(key, vars) is the builder's string lookup; tOpt returns "" for a key that is not in the table yet (a caption whose
// English is still with the owner), so a chart can ship without its caption and never with a made-up one
export function charts(index, numbers, t, tOpt, lang) {
  const nf = new Intl.NumberFormat(lang);
  const m = measure(index);
  const f = n => nf.format(n);
  const badge = t("viz.badge");
  // the caption's second form when two or more entries tie at the maximum, so "the most carried" is never said of a tie
  const cap = (key, vars, ties) => tOpt(ties > 1 ? key + "_tie" : key, vars);
  const modeLabel = label(m.ticker.mode_bucket, t, "n");
  const tickerCap = cap("viz.ticker.caption", { entries: f(m.ticker.entries), mode: modeLabel, max_n: f(m.ticker.max_n), max_d: f(m.ticker.max_d), max_ties: f(m.ticker.max_ties) }, m.ticker.max_ties);
  const lookCap = tOpt("viz.look.caption", { groups: f(m.look.groups), lookalike: f(m.look.lookalike), largest: f(m.look.largest_v), name_groups: f(m.look.name_lookalike) });
  const linkCap = cap("viz.link.caption", { entries: f(m.link.entries), single: f(m.link.single_deployer), max_d: f(m.link.max_d), max_ties: f(m.link.max_ties) }, m.link.max_ties);
  return [
    card(t("viz.ticker.title"), badge, tickerCap, bars(m.ticker.hist, COUNT_BUCKETS, t, "n", nf, false), t("viz.ticker.x"), t("viz.ticker.y")),
    card(t("viz.look.title"), badge, lookCap, bars(m.look.hist, SPELLING_BUCKETS, t, "v", nf, true), t("viz.look.x"), t("viz.look.y")),
    card(t("viz.link.title"), badge, linkCap, bars(m.link.hist, DEPLOYER_BUCKETS, t, "d", nf, false), t("viz.link.x"), t("viz.link.y"))
  ].join("\n");
}

// The ornament: the mock's fixed pattern, 46 columns by 9 rows of glyphs from a ten-glyph alphabet, each drifting in
// opacity on its own period and phase. Deterministic (the same bytes on every build), no data anywhere in it.
export function ornament(t) {
  const glyphs = ["·", ":", "|", "-", "+", "=", "/", "o", "l", "x"];
  const cols = 46, rows = 9, out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const dur = (5.4 + ((r * 3 + c * 5) % 9) * 0.55).toFixed(2), delay = (((r * 5 + c * 3) % 17) * 0.42).toFixed(2);
      row.push(`<span style="animation-duration:${dur}s;animation-delay:-${delay}s">${glyphs[(r * 7 + c * 13) % glyphs.length]}</span>`);
    }
    out.push(`<div class="orn-row">${row.join("")}</div>`);
  }
  return `<div class="chart chart-orn">
  <div class="chart-head"><h3 class="chart-title">${esc(t("viz.orn.title"))}</h3><span class="badge badge-notdata">${esc(t("viz.orn.badge"))}</span></div>
  <div class="orn" data-orn aria-hidden="true">${out.join("")}</div>
</div>`;
}
