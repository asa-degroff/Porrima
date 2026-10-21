/**
 * Wire-drift referee (run with tsx, read-only).
 *
 *   npx tsx src/scripts/wire-drift.ts --chat 30e582f6 [--boundaries N] [--show]
 *
 * Why this exists: the request-log recorder stores `messageRefs` on every
 * request — one content-addressed sha1 per message, with the bytes in
 * `llm_request_blobs`. That makes the exact message list of any past request
 * recoverable, so two adjacent requests can be compared message-by-message.
 * Comparing the LAST request of a turn with the FIRST request of the next turn
 * answers the only question that matters for replay integrity: does the
 * persisted-record rebuild produce the bytes the provider actually saw?
 *
 * A turn boundary is clean when the diff is a pure tail append (the assistant
 * reply plus the new user message). Anything else is drift, and drift is what
 * busts the engine's checkpointed prefix: the engine re-reads everything from
 * the checkpoint before the first changed message.
 *
 * Classifications:
 *   REKEY  same text, moved between `content` and `reasoning_content`
 *          (thinking serialized as visible content — the fold)
 *   ROLE   role changed between the two requests
 *   SHAPE  text identical, other fields changed (tool_call ids/arguments)
 *   DROP   message present live, absent on rebuild
 *   ADD    message absent live, injected by the rebuild
 *   CONTENT text genuinely differs
 *
 * Nothing here is written to the database.
 */
import Database from "better-sqlite3";
import { appDataPath } from "../services/paths.js";

type Args = {
  chat: string;
  boundaries: number;
  show: boolean;
  purposes: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { chat: "", boundaries: 40, show: false, purposes: ["chat"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chat") args.chat = argv[++i] ?? "";
    else if (a === "--boundaries") args.boundaries = Number(argv[++i] ?? "40");
    else if (a === "--show") args.show = true;
    else if (a === "--purposes") args.purposes = (argv[++i] ?? "chat").split(",");
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx src/scripts/wire-drift.ts --chat <id-prefix> [--boundaries N] [--purposes chat,compaction] [--show]");
      process.exit(0);
    }
  }
  if (!args.chat) {
    console.error("error: --chat <id-prefix> is required");
    process.exit(2);
  }
  return args;
}

type Req = {
  id: string;
  at: string;
  iteration: number;
  purpose: string;
  messageCount: number;
  refs: string[];
};

function loadRequests(db: Database.Database, args: Args): Req[] {
  const placeholders = args.purposes.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, timestamp, iteration, purpose, message_count, request_json
       FROM llm_requests
      WHERE chat_id LIKE ? AND purpose IN (${placeholders}) AND request_json IS NOT NULL
      ORDER BY timestamp ASC`,
  ).all(`${args.chat}%`, ...args.purposes) as Array<{
    id: string; timestamp: number; iteration: number | null; purpose: string;
    message_count: number | null; request_json: string;
  }>;

  const out: Req[] = [];
  for (const row of rows) {
    let refs: string[] = [];
    try {
      const parsed = JSON.parse(row.request_json);
      refs = Array.isArray(parsed?.messageRefs) ? parsed.messageRefs : [];
    } catch {
      continue;
    }
    if (refs.length === 0) continue;
    out.push({
      id: row.id,
      at: new Date(row.timestamp).toISOString(),
      iteration: row.iteration ?? 0,
      purpose: row.purpose,
      messageCount: row.message_count ?? refs.length,
      refs,
    });
  }
  return out;
}

/** Longest common prefix / suffix — the wire only ever appends, so a middle
 *  change region is the entire drift surface. No LCS needed. */
function diffRegion(a: string[], b: string[]): { head: number; mA: string[]; mB: string[]; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, mA: a.slice(head, a.length - tail), mB: b.slice(head, b.length - tail), tail };
}

type Classified = {
  kind: "REKEY" | "ROLE" | "SHAPE" | "DROP" | "ADD" | "CONTENT";
  index: number;
  detail: string;
  probe: string;
};

function textOf(msg: any): { content: string; reasoning: string; role: string } {
  const flat = (v: any): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
    return "";
  };
  return {
    role: String(msg?.role ?? ""),
    content: flat(msg?.content),
    reasoning: flat(msg?.reasoning_content),
  };
}

function normalizeKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function classifyPair(prev: any | null, next: any | null, index: number): Classified {
  if (!prev && next) return { kind: "ADD", index, detail: `role=${next.role}`, probe: probeOf(next) };
  if (prev && !next) return { kind: "DROP", index, detail: `role=${prev.role}`, probe: probeOf(prev) };
  const p = textOf(prev);
  const n = textOf(next);
  if (p.role !== n.role) {
    return { kind: "ROLE", index, detail: `${p.role} -> ${n.role}`, probe: probeOf(next) };
  }
  // The fold: reasoning text surfaces as visible content (or vice versa).
  const moved =
    (p.reasoning && n.content && normalizeKey(p.reasoning) === normalizeKey(n.content) && !p.content) ||
    (p.content && n.reasoning && normalizeKey(p.content) === normalizeKey(n.reasoning) && !n.content);
  if (moved) {
    const from = p.reasoning ? "reasoning_content" : "content";
    const to = n.content ? "content" : "reasoning_content";
    return { kind: "REKEY", index, detail: `${from} -> ${to} (${Math.max(p.reasoning.length, p.content.length)}ch)`, probe: probeOf(next) };
  }
  const sameText = normalizeKey(p.content) === normalizeKey(n.content) && normalizeKey(p.reasoning) === normalizeKey(n.reasoning);
  if (sameText) {
    return { kind: "SHAPE", index, detail: "text equal, other fields differ", probe: probeOf(next) };
  }
  return { kind: "CONTENT", index, detail: "text differs", probe: probeOf(next) };
}

function probeOf(msg: any): string {
  const t = textOf(msg);
  const body = t.reasoning || t.content;
  const keys = Object.keys(msg ?? {}).sort().join("/");
  return `${keys} :: ${body.slice(0, 90).replace(/\s+/g, " ")}`;
}

function findRow(app: Database.Database, probe: string): string {
  const needle = probe.split(":: ")[1] ?? "";
  if (needle.length < 24) return "row match: n/a";
  const row = app.prepare(
    `SELECT sequence, payload_json FROM chat_message_rows
      WHERE payload_json LIKE ? ORDER BY sequence DESC LIMIT 1`,
  ).get(`%${needle.slice(0, 60).replace(/[%_]/g, "")}%`) as { sequence: number; payload_json: string } | undefined;
  if (!row) return "row match: none";
  let flags: string[] = [];
  try {
    const payload = JSON.parse(row.payload_json);
    flags = Object.keys(payload).filter((k) => k.startsWith("_"));
  } catch { /* keep empty */ }
  return `row match: seq ${row.sequence}${flags.length ? ` [${flags.join(",")}]` : ""}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const reqDb = new Database(appDataPath("porrima.db"), { readonly: true });
  const chatDb = new Database(appDataPath("app.db"), { readonly: true });

  const reqs = loadRequests(reqDb, args);
  if (reqs.length < 2) {
    console.log(`no request pairs found for chat ${args.chat}`);
    return;
  }

  const boundaries: Array<{ prev: Req; next: Req }> = [];
  for (let i = 1; i < reqs.length && boundaries.length < args.boundaries; i++) {
    if (reqs[i].iteration === 1 && reqs[i - 1].iteration !== 1) {
      boundaries.push({ prev: reqs[i - 1], next: reqs[i] });
    }
  }

  console.log(`chat ${args.chat}: ${reqs.length} recorded requests, ${boundaries.length} turn boundaries\n`);

  const totals = new Map<string, number>();
  for (const { prev, next } of boundaries) {
    const { head, mA, mB, tail } = diffRegion(prev.refs, next.refs);
    const delta = next.refs.length - prev.refs.length;
    const label = `${prev.at} iter${prev.iteration} (${prev.refs.length}) -> ${next.at} iter1 (${next.refs.length})`;

    // Nothing was removed or rewritten from the live wire: the rebuild is a
    // prefix-preserving extension. That is the only shape the engine's
    // checkpoint chain can reuse, so it is the definition of clean.
    if (mA.length === 0) {
      const appended = mB.map((hash) => roleOfBlob(reqDb, hash));
      const expected = appended.length === 2 && appended[0] === "assistant" && appended[1] === "user";
      if (expected) {
        console.log(`CLEAN  ${label}  delta=+${delta} tail append (assistant reply + new user message)`);
        totals.set("clean", (totals.get("clean") ?? 0) + 1);
        continue;
      }
      console.log(`APPEND ${label}  delta=${delta >= 0 ? "+" : ""}${delta}  unexpected append: ${appended.join(",") || "(none)"}`);
      totals.set("APPEND", (totals.get("APPEND") ?? 0) + 1);
      continue;
    }

    console.log(`DRIFT  ${label}  delta=${delta >= 0 ? "+" : ""}${delta}  head=${head} tail=${tail} middle prev=${mA.length} next=${mB.length}`);
    const pairs = Math.max(mA.length, mB.length);
    for (let k = 0; k < pairs; k++) {
      const prevMsg = k < mA.length ? mA[k] : null;
      const nextMsg = k < mB.length ? mB[k] : null;
      if (prevMsg === null && nextMsg === null) continue;
      const prevJson = prevMsg ? readBlob(reqDb, prevMsg) : null;
      const nextJson = nextMsg ? readBlob(reqDb, nextMsg) : null;
      const cls = classifyPair(prevJson, nextJson, head + k);
      totals.set(cls.kind, (totals.get(cls.kind) ?? 0) + 1);
      const rowRef = cls.kind === "REKEY" || cls.kind === "DROP" || cls.kind === "ROLE" ? `  (${findRow(chatDb, cls.probe)})` : "";
      console.log(`   ${cls.kind.padEnd(7)} @${String(cls.index).padStart(4)}  ${cls.detail}${rowRef}`);
      if (args.show) console.log(`            ${cls.probe}`);
    }
    console.log("");
  }

  console.log("totals:");
  for (const [kind, count] of [...totals.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${kind.padEnd(8)} ${count}`);
  }
  const drifted = [...totals.entries()].filter(([k]) => k !== "clean").reduce((s, [, c]) => s + c, 0);
  console.log(`\n${drifted === 0 ? "no wire-vs-replay drift at any examined boundary" : `${drifted} drifted message(s)`}`);

  reqDb.close();
  chatDb.close();
}

function roleOfBlob(db: Database.Database, hash: string): string {
  const msg = readBlob(db, hash);
  return msg?.role ?? "?";
}

function readBlob(db: Database.Database, hash: string): any | null {
  const row = db.prepare("SELECT text FROM llm_request_blobs WHERE hash = ?").get(hash) as { text: string } | undefined;
  if (!row?.text) return null;
  try {
    return JSON.parse(row.text);
  } catch {
    return { role: "?", content: row.text };
  }
}

main();
