/**
 * Reverse-engineered CLI schema, not a vendor API: gen_metadata #1.#19 is the
 * model and #1.#4 is usage. Usage #1 is a model enum id (not a token count), #2
 * is uncached input, #3 is total output (#9 reasoning plus #10 response text),
 * #5 is cache read, #11 is response ID. Some responses appear only in
 * steps.metadata: usage at #9, or at #28.#2 (without #1) on checkpoint steps.
 * Field mapping reference (generation records only):
 * https://github.com/junhoyeo/tokscale/blob/04e1e3802388070005328047579220c80c2350bd/crates/tokscale-core/src/sessions/antigravity_cli.rs
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
  addUsage,
  beginStoreTransaction,
  commitStoreTransaction,
  rollbackStoreTransaction,
  deleteFileEntry,
  fileKey,
  newFileEntry,
  resetFileEntry,
  dedupKeyFor as makeDedupKey,
} from "./store.mjs";
import { localDay } from "./util.mjs";

const VERSION = 3;
const MAX_BLOB = 16 * 1024 * 1024;
const MAX_FIELDS = 100_000;
const CHECKPOINT_STEP = 23;

export function antigravityConversation(file) {
  return file.endsWith(".db")
    ? path.basename(file, ".db")
    : path.basename(path.dirname(path.dirname(path.dirname(file))));
}

// Keep uint64 fields exact, including unrelated sentinel values outside JS's safe range.
function varint(bytes, cursor) {
  let value = 0n;
  for (let shift = 0; shift < 70; shift += 7) {
    if (cursor.pos >= bytes.length) throw new Error("truncated protobuf varint");
    const byte = bytes[cursor.pos++];
    if (shift === 63 && byte > 1) throw new Error("protobuf uint64 overflow");
    value |= BigInt(byte & 127) << BigInt(shift);
    if (byte < 128) return value;
  }
}

export function protobufFields(bytes) {
  const cursor = { pos: 0 };
  const out = [];
  while (cursor.pos < bytes.length) {
    if (out.length >= MAX_FIELDS) throw new Error("too many protobuf fields");
    const tag = varint(bytes, cursor);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 536870911) throw new Error("invalid protobuf tag");
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 1 || wire === 2 || wire === 5) {
      const size = wire === 2 ? Number(varint(bytes, cursor)) : wire === 1 ? 8 : 4;
      if (size > bytes.length - cursor.pos) {
        throw new Error("invalid protobuf length");
      }
      value = bytes.subarray(cursor.pos, cursor.pos + size);
      cursor.pos += size;
    } else throw new Error("unsupported protobuf wire type");
    out.push({ number, wire, value });
  }
  return out;
}

function blob(fields, number) {
  return fields.find((f) => f.number === number && f.wire === 2)?.value;
}
function integer(fields, number) {
  const value = fields.find((f) => f.number === number && f.wire === 0)?.value ?? 0n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsafe usage integer");
  return Number(value);
}
function text(bytes, max = 256) {
  if (!bytes || bytes.length === 0 || bytes.length > max) return "";
  const value = Buffer.from(bytes).toString("utf8");
  return /[\x00-\x1f\x7f\ufffd]/.test(value) ? "" : value;
}
function timestamp(bytes) {
  if (!bytes) return null;
  const fields = protobufFields(bytes);
  const seconds = integer(fields, 1), nanos = integer(fields, 2);
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  return seconds > 0 && nanos < 1e9 && Number.isSafeInteger(ms) &&
    Number.isFinite(new Date(ms).getTime()) ? ms : null;
}
function responseId(usage) { return text(blob(usage, 11)); }
function provider(model) {
  // Model publisher, not the account/billing gateway used by Antigravity.
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("claude-")) return "anthropic";
  return "unknown";
}

function decodeUsage(bytes) {
  const usage = protobufFields(bytes);
  const input = integer(usage, 2), output = integer(usage, 3), cacheRead = integer(usage, 5);
  const reasoning = integer(usage, 9), responseText = integer(usage, 10);
  if (!Number.isSafeInteger(input + output + cacheRead)) throw new Error("unsafe token total");
  if (reasoning + responseText !== output) throw new Error("inconsistent output accounting");
  return {
    modelId: integer(usage, 1), responseId: responseId(usage),
    // A record without measured tokens is not usage.
    tokens: input + output + cacheRead === 0 ? null : { input, output, cacheRead, cacheWrite: 0, reasoning },
  };
}

/** Collects the model id to model name pairs it sees into `models`. */
export function decodeAntigravityGeneration(bytes, models) {
  const outer = protobufFields(bytes);
  const packedSteps = blob(outer, 2);
  let step = null;
  if (packedSteps?.length) {
    const value = varint(packedSteps, { pos: 0 });
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) step = Number(value);
  }
  const generations = [];
  let recognizedUsage = false;
  for (const field of outer) {
    if (field.number !== 1 || field.wire !== 2) continue;
    const inner = protobufFields(field.value);
    const usageBytes = blob(inner, 4);
    if (!usageBytes) continue;
    const usage = decodeUsage(usageBytes);
    recognizedUsage = true;
    const model = text(blob(inner, 19));
    if (usage.modelId && model) models?.set(usage.modelId, model);
    if (!usage.tokens) continue;
    generations.push({ step, model: model || "unknown", responseId: usage.responseId, tokens: usage.tokens });
  }
  if (!recognizedUsage) throw new Error("unrecognized generation metadata");
  return generations;
}

function sessionMetadata(bytes) {
  const fields = protobufFields(bytes);
  let project = "unknown";
  const workspace = blob(fields, 1);
  if (workspace) {
    const uri = text(blob(protobufFields(workspace), 1), 8192);
    try { if (uri.startsWith("file://")) project = fileURLToPath(uri); } catch { /* unknown */ }
  }
  return { timestamp: timestamp(blob(fields, 2)), project };
}

function stepTimestamp(bytes, id) {
  if (!bytes || !id) return null;
  const fields = protobufFields(bytes);
  const usage = blob(fields, 9);
  // Trust a step timestamp only when it identifies the same response.
  if (!usage || responseId(protobufFields(usage)) !== id) return null;
  return timestamp(blob(fields, 1));
}

function decodeStep(bytes, stepType, onMalformed) {
  const fields = protobufFields(bytes);
  const direct = blob(fields, 9);
  const summary = stepType === CHECKPOINT_STEP ? blob(fields, 28) : undefined;
  if (!direct && !summary) return null;
  // Each payload fails alone, so a bad one cannot hide usage in the other.
  const attempt = (decode) => { try { return decode(); } catch { onMalformed(); } };
  return {
    created: timestamp(blob(fields, 1)),
    direct: direct && attempt(() => decodeUsage(direct)),
    checkpoint: summary && attempt(() => {
      const usage = blob(protobufFields(summary), 2);
      return usage && decodeUsage(usage);
    }),
  };
}

export async function scanAntigravityDb(store, source, file, sink, stats, options = {}) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") sink.warn(`Antigravity: cannot stat database ${path.basename(file)}; previous accepted data retained.`);
    return { dirty: false, aborted: false };
  }
  if (!info.isFile()) return { dirty: false, aborted: false };
  let wal = null;
  try {
    wal = await stat(`${file}-wal`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      sink.warn(`Antigravity: cannot stat database WAL ${path.basename(file)}; previous accepted data retained.`);
      return { dirty: false, aborted: false };
    }
  }
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
  let entry = store.files[fileKey(source.id, file)];
  const supersededKeys = options.supersededKeys ?? [];
  if (supersededKeys.length === 0 && entry?.state.agyDbVersion === VERSION && entry.state.agyDbFingerprint === fingerprint) {
    for (const warning of entry.state.agyWarnings ?? []) sink.warn(warning);
    for (const note of entry.state.agyNotes ?? []) sink.note(note);
    stats.unchangedFiles += 1;
    return { dirty: false, aborted: false };
  }
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch {
    sink.warn("Antigravity SQLite requires a Node runtime with node:sqlite; skipped.");
    return { dirty: false, aborted: false };
  }
  const tx = beginStoreTransaction(store, { fileId: entry?.id });
  let db;
  const counts = { oversized: 0, malformed: 0, approximateTime: 0, missingId: 0 };
  let rows = 0;
  let decodedRows = 0;
  let usages = 0;
  let bytes = 0;
  try {
    for (const key of supersededKeys) deleteFileEntry(store, key);
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    db.exec("BEGIN");
    // SQLite limits the returned blob before it crosses into JS memory.
    const limited = (column) => `CASE WHEN length(${column}) <= ${MAX_BLOB} THEN ${column} ELSE NULL END`;
    let session = {};
    const meta = db.prepare(`SELECT ${limited("data")} AS data FROM trajectory_metadata_blob WHERE id = 'main'`).get();
    if (meta?.data) {
      try { session = sessionMetadata(meta.data); } catch { counts.malformed += 1; }
    } else if (meta) counts.oversized += 1;
    const stepQuery = db.prepare(`SELECT ${limited("metadata")} AS data FROM steps WHERE idx = ?`);
    if (!entry) entry = newFileEntry(store, {
      sourceId: source.id, adapter: source.adapter, path: file,
      dev: String(info.dev), ino: String(info.ino), size: 0, mtimeMs: 0, compressed: false,
    });
    else resetFileEntry(store, entry);
    const conversation = antigravityConversation(file);
    const add = (created, model, tokens, dedupKey) => {
      usages += 1;
      if (created === null) {
        counts.approximateTime += 1;
        created = session.timestamp ?? info.mtimeMs;
      }
      addUsage(store, entry, {
        day: localDay(created), session: `antigravity:${conversation}`, harness: "antigravity",
        model, provider: provider(model), project: session.project ?? "unknown",
      }, tokens, dedupKey);
    };
    // Resolves to the reason for an interruption, which the caller must roll back.
    const eachRow = async (sql, handle) => {
      // Node 22.15 iterators do not retain their prepared statement across garbage collection.
      const query = db.prepare(sql);
      const records = Object.assign(query.iterate(), { statementOwner: query });
      for (const record of records) {
        if (rows > 0 && rows % 128 === 0) {
          options.onStreamProgress?.({ file, bytes, phase: "scan" });
          // Let signal handlers and generation-fence polling run between batches.
          await setImmediate();
        }
        const stopped = options.shouldStop?.();
        const expired = rows > 0 && Number.isFinite(options.deadline) &&
          (options.now ?? Date.now)() >= options.deadline;
        if (stopped || expired) return stopped ? "stop" : "budget";
        rows += 1;
        bytes += record.data?.length ?? 0;
        if (record.data) handle(record);
        else counts.oversized += 1;
      }
      return null;
    };
    const interrupted = (reason) => {
      rollbackStoreTransaction(tx);
      return { dirty: false, aborted: true, reason };
    };
    const retain = (detail) => {
      rollbackStoreTransaction(tx);
      sink.warn(`Antigravity ${path.basename(file)}: ${detail}; previous accepted data retained.`);
      return { dirty: false, aborted: false };
    };
    const responseKey = (id) => makeDedupKey("antigravity", "response", id);
    const models = new Map();
    const countedIds = new Set();
    // A generation record without a response ID still counts its step's response.
    const countedSteps = new Set();
    let reason = await eachRow(`SELECT idx, ${limited("data")} AS data FROM gen_metadata ORDER BY idx`, (record) => {
      let generations;
      try { generations = decodeAntigravityGeneration(record.data, models); } catch { counts.malformed += 1; return; }
      decodedRows += 1;
      for (let index = 0; index < generations.length; index += 1) {
        const generation = generations[index];
        let created = null;
        if (generation.step !== null && generation.responseId) {
          const step = stepQuery.get(generation.step);
          try { created = stepTimestamp(step?.data, generation.responseId); } catch { /* use documented fallback */ }
        }
        if (generation.responseId) countedIds.add(generation.responseId);
        else {
          counts.missingId += 1;
          countedSteps.add(generation.step);
        }
        add(created, generation.model, generation.tokens, generation.responseId
          ? responseKey(generation.responseId)
          : makeDedupKey("antigravity", "generation", conversation, record.idx, index));
      }
    });
    if (reason) return interrupted(reason);
    // An undecodable snapshot is not evidence that previously measured usage vanished.
    if (rows > 0 && decodedRows === 0) return retain("no decodable generation records");
    const addStepUsage = (usage, created) => {
      // Without a response ID, step usage cannot be told apart from a generation record.
      if (!usage?.tokens || !usage.responseId || countedIds.has(usage.responseId)) return;
      countedIds.add(usage.responseId);
      add(created, models.get(usage.modelId) ?? "unknown", usage.tokens, responseKey(usage.responseId));
    };
    // Checkpoint copies wait for every #9 usage, which alone carries the model id.
    const checkpoints = [];
    reason = await eachRow(`SELECT idx, step_type, ${limited("metadata")} AS data FROM steps WHERE metadata IS NOT NULL ORDER BY idx`, (record) => {
      let step;
      const malformed = () => { counts.malformed += 1; };
      try { step = decodeStep(record.data, record.step_type, malformed); } catch { malformed(); return; }
      if (!step) return;
      // Marking the ID also covers a checkpoint copy of that response.
      if (countedSteps.has(record.idx)) countedIds.add(step.direct?.responseId);
      addStepUsage(step.direct, step.created);
      if (step.checkpoint) checkpoints.push(step);
    });
    if (reason) return interrupted(reason);
    for (const step of checkpoints) addStepUsage(step.checkpoint, step.created);
    if (usages === 0 && (counts.malformed || counts.oversized)) return retain("no usable records and some were skipped");
    db.exec("COMMIT");
    const warnings = [];
    const notes = [];
    const prefix = `Antigravity ${path.basename(file)}:`;
    if (counts.oversized) warnings.push(`${prefix} ${counts.oversized} blobs exceed the 16 MiB limit; skipped.`);
    if (counts.malformed) warnings.push(`${prefix} ${counts.malformed} malformed metadata records were skipped.`);
    if (counts.approximateTime) notes.push(`${prefix} ${counts.approximateTime} generations use session time or database mtime (no verified step timestamp).`);
    if (counts.missingId) notes.push(`${prefix} ${counts.missingId} generations have no response ID; deduplicated by conversation and generation index.`);
    entry.dev = String(info.dev); entry.ino = String(info.ino);
    entry.size = info.size; entry.mtimeMs = info.mtimeMs;
    entry.state.agyDbVersion = VERSION;
    entry.state.agyDbFingerprint = fingerprint;
    entry.state.agyWarnings = warnings;
    entry.state.agyNotes = notes;
    commitStoreTransaction(tx);
    for (const warning of warnings) sink.warn(warning);
    for (const note of notes) sink.note(note);
    stats.filesRead += 1;
    stats.bytesRead += info.size + (wal?.size ?? 0);
    return { dirty: true, aborted: false };
  } catch {
    rollbackStoreTransaction(tx);
    // Do not leak strings from SQLite or protobuf source payloads in diagnostics.
    sink.warn(`Antigravity: cannot read generation database ${path.basename(file)}; previous accepted data retained.`);
    return { dirty: false, aborted: false };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}
