/**
 * Memory adapters for the two remaining stores. Both have D1 twins in cloudflare/d1-store.mjs with the same contract.
 *
 * UserStore:  get(telegramUserId) -> row|null; upsert({telegramUserId, mode?, paused?}) -> row
 * OutboxStore: enqueue({telegramUserId, privateChatId, text, inlineKeyboard}) -> row;
 *              lease(limit, nowSeconds, leaseSeconds) -> rows; ack(id) ; fail(id, reason)
 *
 * The outbox exists because the Copy service holds no bot token: Lintcha Core drains it through the signed
 * gateway channel and delivers each line with its own token, after the same response validation as replies.
 */
export const USER_MODES = Object.freeze(["NOTIFY_ONLY", "AUTO_BUY", "CONFIRM_EACH"]);

export class MemoryUserStore {
  constructor(clock = () => Math.floor(Date.now() / 1000)) { this.rows = new Map(); this.referrals = new Map(); this.clock = clock; }
  async get(telegramUserId) { return this.rows.get(String(telegramUserId)) || null; }
  async upsert({ telegramUserId, privateChatId, mode, paused }) {
    const id = String(telegramUserId);
    const now = this.clock();
    const existing = this.rows.get(id) || { telegramUserId: id, privateChatId: null, mode: "NOTIFY_ONLY", paused: 1, createdAt: now, updatedAt: now };
    if (mode !== undefined) { if (!USER_MODES.includes(mode)) throw new Error("INVALID_USER_MODE"); existing.mode = mode; }
    if (paused !== undefined) existing.paused = paused ? 1 : 0;
    if (privateChatId !== undefined) existing.privateChatId = String(privateChatId);
    existing.updatedAt = now;
    this.rows.set(id, existing);
    return structuredClone(existing);
  }
  async wallets(telegramUserId) { return structuredClone(this.walletRows?.get(String(telegramUserId)) || []); }
  async addWallet({ telegramUserId, publicAddress, walletKind = "EXTERNAL", publicLabel = null }) {
    if (!/^0x[0-9a-f]{40}$/.test(publicAddress)) throw new Error("INVALID_PUBLIC_ADDRESS");
    if (!["EXTERNAL", "LOCAL_SECURE_SHEET"].includes(walletKind)) throw new Error("INVALID_WALLET_KIND");
    this.walletRows ||= new Map();
    const list = this.walletRows.get(String(telegramUserId)) || [];
    if (list.length >= 5) throw new Error("WALLET_LIMIT_REACHED");
    if (!list.some((row) => row.publicAddress === publicAddress)) list.push({ publicAddress, walletKind, publicLabel, createdAt: this.clock() });
    this.walletRows.set(String(telegramUserId), list);
    return structuredClone(list);
  }
  async recordReferral({ telegramUserId, source }) {
    if (source !== "SITE") throw new Error("INVALID_REFERRAL_SOURCE");
    const key = `${source}:${String(telegramUserId)}`, now = this.clock();
    const row = this.referrals.get(key) || { source, telegramUserId: String(telegramUserId), firstSeenAt: now, lastSeenAt: now, starts: 0 };
    row.lastSeenAt = now; row.starts += 1; this.referrals.set(key, row);
    return structuredClone(row);
  }
  async referralStats(source = "SITE") {
    if (source !== "SITE") throw new Error("INVALID_REFERRAL_SOURCE");
    const rows = [...this.referrals.values()].filter((row) => row.source === source);
    return { source, uniqueUsers: rows.length, starts: rows.reduce((sum, row) => sum + row.starts, 0) };
  }
}

export class MemoryOutboxStore {
  constructor(clock = () => Math.floor(Date.now() / 1000)) { this.rows = new Map(); this.counter = 0; this.clock = clock; }
  async enqueue({ telegramUserId, privateChatId, text, inlineKeyboard = [] , dedupeKey = null }) {
    if (dedupeKey && [...this.rows.values()].some((row) => row.dedupeKey === dedupeKey)) return null;
    const row = { id: String(++this.counter), telegramUserId: String(telegramUserId), privateChatId: String(privateChatId), text, inlineKeyboard, dedupeKey, state: "PENDING", attempts: 0, leaseUntil: 0, createdAt: this.clock() };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }
  async lease(limit, nowSeconds, leaseSeconds = 60) {
    const rows = [...this.rows.values()].filter((row) => row.state === "PENDING" && row.leaseUntil <= nowSeconds).slice(0, limit);
    for (const row of rows) { row.leaseUntil = nowSeconds + leaseSeconds; row.attempts += 1; }
    return rows.map((row) => structuredClone(row));
  }
  async ack(id) { const row = this.rows.get(String(id)); if (row) row.state = "SENT"; }
  async fail(id, reason) { const row = this.rows.get(String(id)); if (row) { row.lastError = String(reason).slice(0, 64); if (row.attempts >= 10) row.state = "DEAD"; } }
}
