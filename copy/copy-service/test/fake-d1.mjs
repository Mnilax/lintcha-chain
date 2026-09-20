import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Minimal D1 API shim over node:sqlite for adapter tests: prepare().bind().run()/first()/all() and batch(). */
export function fakeD1({ schema = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (schema) db.exec(readFileSync(fileURLToPath(new URL("../src/schema.sql", import.meta.url)), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value))),
    async run() { const result = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params), success: true }; },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) { db.exec("BEGIN"); try { const out = []; for (const item of statements) out.push(await item.run()); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    raw: db,
  };
}
