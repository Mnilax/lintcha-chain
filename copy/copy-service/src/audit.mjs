import { createHash } from "node:crypto";

const FORBIDDEN_KEY = /seed|mnemonic|private.?key|vault|raw.?transaction|signed.?transaction|bot.?token|webhook.?secret|recovery/i;
const FORBIDDEN_VALUE = /(?:seed phrase|private key|mnemonic|bot token)/i;

export function publicAuditPayload(value) {
  if (Array.isArray(value)) return value.map(publicAuditPayload);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error("SENSITIVE_AUDIT_FIELD_REJECTED");
      result[key] = publicAuditPayload(item);
    }
    return result;
  }
  if (typeof value === "string" && FORBIDDEN_VALUE.test(value)) throw new Error("SENSITIVE_AUDIT_VALUE_REJECTED");
  return value;
}

function digest(record) {
  return createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}

export class HashChainedAuditLog {
  constructor({ sink, clock = () => Date.now() }) {
    if (typeof sink?.append !== "function") throw new Error("COPY_AUDIT_SINK_REQUIRED");
    this.sink = sink;
    this.clock = clock;
    this.previousHash = "0".repeat(64);
    this.sequence = 0;
  }

  /** Continues the chain from a durable sink's last record instead of restarting at zero in every isolate. */
  static async resume({ sink, clock }) {
    const log = new HashChainedAuditLog({ sink, clock });
    if (typeof sink.head === "function") {
      const head = await sink.head();
      log.sequence = Number(head.sequence) || 0;
      log.previousHash = head.hash || "0".repeat(64);
    }
    return log;
  }

  async append(type, payload) {
    const body = Object.freeze({
      namespace: "lintcha_copy",
      sequence: ++this.sequence,
      at: this.clock(),
      type: String(type),
      payload: publicAuditPayload(payload),
      previousHash: this.previousHash,
    });
    const record = Object.freeze({ ...body, hash: digest(body) });
    await this.sink.append(record);
    this.previousHash = record.hash;
    return record;
  }
}

export class MemoryAuditSink {
  constructor() { this.records = []; }
  async append(record) { this.records.push(structuredClone(record)); }
}
