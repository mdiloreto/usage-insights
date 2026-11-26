import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHostRecord, readHostRecord } from "../scripts/quota/host.mjs";
import { WIRE_VERSION as HELPER_WIRE } from "../scripts/quota/normalize.mjs";
import { WIRE_VERSION } from "../mods/insights/fleet-quota/protocol.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/omarchy/", import.meta.url));
const load = (name) => readFile(path.join(fixtures, `${name}.json`), "utf8");
const observed = (text) => Math.floor(JSON.parse(text).limitsFetchedAt / 1_000);
const DAY = 86_400;

test("helper and viewer agree on the wire version", () => {
  assert.equal(HELPER_WIRE, WIRE_VERSION);
  assert.equal(WIRE_VERSION, 2);
});

test("the Claude record maps to session, weekly and Fable with fraction-to-percent conversion", async () => {
  const text = await load("claude");
  const got = parseHostRecord("claude", text, observed(text) + 5);
  assert.equal(got.status, "ok");
  assert.equal(got.current, true);
  const { reading } = got;
  assert.equal(reading.source, "host");
  assert.equal(reading.account, null);
  assert.equal(reading.observedAt, observed(text));
  assert.equal(reading.plan, "max");
  assert.deepEqual(reading.windows.map((w) => [w.id, w.short, w.percent, w.durationSec]),
    [["session", "5h", 4, 18_000], ["weekly_all", "wk", 8, 604_800], ["weekly_scoped:Fable", "Fable", 0, 604_800]]);
  assert.equal(reading.windows[0].resetsAt, Math.floor(Date.parse("2026-11-26T22:59:59Z") / 1_000));
});

test("Copilot maps its monthly allowance and an exact 1.0 is 100", async () => {
  const text = await load("copilot");
  const { reading, current } = parseHostRecord("copilot", text, observed(text) + 5);
  assert.equal(current, true);
  assert.equal(reading.plan, "enterprise");
  assert.deepEqual(reading.windows.map((w) => [w.id, w.short, w.long, w.percent, w.durationSec]),
    [["monthly", "mo", "Monthly", 100, null]]);
});

test("Antigravity treats an empty resetsAt as no reset and a fresh 0.0 as a real 0", async () => {
  const text = await load("agy");
  const { reading, current } = parseHostRecord("agy", text, observed(text) + 5);
  assert.equal(current, true);
  assert.equal(reading.plan, "pro");
  assert.deepEqual(reading.windows.map((w) => [w.id, w.percent, w.resetsAt]),
    [["session", 0, null], ["weekly_all", 0, null]]);
});

test("Codex maps a weekly-only record to the primary window", async () => {
  const text = await load("codex-stale");
  const { reading } = parseHostRecord("codex", text, observed(text) + 5);
  assert.deepEqual(reading.windows.map((w) => [w.id, w.short, w.percent]), [["codex:primary", "wk", 100]]);
  assert.equal(reading.plan, "pro");
});

test("stale records are dated history and never a current reading", async () => {
  const codex = await load("codex-stale");
  assert.equal(parseHostRecord("codex", codex, observed(codex) + 60).current, false);
  const old = await load("agy-old");
  const fiveDays = parseHostRecord("agy", old, observed(old) + 5 * DAY);
  assert.equal(fiveDays.status, "ok");
  assert.equal(fiveDays.current, false);
  assert.equal(fiveDays.reading.observedAt, observed(old));
  // The 2026-11-11 record is older than the 14-day history bound on 2026-11-26.
  assert.deepEqual(parseHostRecord("agy", old, observed(old) + 15 * DAY), { status: "unavailable", reading: null, current: false });
  const notReady = JSON.stringify({ ...JSON.parse(await load("claude")), ready: false });
  assert.equal(parseHostRecord("claude", notReady, observed(notReady) + 5).current, false);
  const fresh = await load("claude");
  assert.equal(parseHostRecord("claude", fresh, observed(fresh) + 899).current, true);
  assert.equal(parseHostRecord("claude", fresh, observed(fresh) + 900).current, false);
  // Every window already reset: waiting for a newer fetch, not a current value.
  const past = new Date((observed(fresh) - 100) * 1_000).toISOString();
  const reset = JSON.stringify({ ...JSON.parse(fresh),
    limits: [{ label: "Weekly (7-day)", percent: 0.5, resetsAt: past }] });
  assert.equal(parseHostRecord("claude", reset, observed(fresh) + 5).current, false);
});

test("a future fetch time and a missing fetch time yield no reading", async () => {
  const text = await load("claude");
  assert.equal(parseHostRecord("claude", text, observed(text) - 1).status, "unavailable");
  const { limitsFetchedAt, ...without } = JSON.parse(text);
  assert.ok(limitsFetchedAt);
  assert.equal(parseHostRecord("claude", JSON.stringify(without), observed(text)).status, "unavailable");
});

test("unknown or missing schema versions are an unsupported source", async () => {
  const text = await load("unknown-schema");
  assert.deepEqual(parseHostRecord("claude", text, observed(text) + 5), { status: "unsupported-source", reading: null, current: false });
  const { schemaVersion, ...without } = JSON.parse(await load("claude"));
  assert.equal(schemaVersion, 1);
  assert.equal(parseHostRecord("claude", JSON.stringify(without), observed(text)).status, "unsupported-source");
});

test("labels with an email are dropped and never cross the boundary", async () => {
  const text = await load("email-label");
  const got = parseHostRecord("claude", text, observed(text) + 5);
  assert.deepEqual(got.reading.windows.map((w) => [w.id, w.percent]), [["weekly_all", 8]]);
  assert.doesNotMatch(JSON.stringify(got), /@|example|person|owner/);
  const onlyEmail = JSON.stringify({ ...JSON.parse(text), limits: JSON.parse(text).limits.slice(0, 2) });
  assert.equal(parseHostRecord("claude", onlyEmail, observed(text) + 5).status, "unsupported");
  const control = JSON.stringify({ ...JSON.parse(text), limits: [{ label: "Weekly (7-day)\u0007", percent: 0.1, resetsAt: "" }] });
  assert.equal(parseHostRecord("claude", control, observed(text) + 5).status, "unsupported");
});

test("unmapped labels are dropped, not displayed raw", async () => {
  const base = JSON.parse(await load("claude"));
  const extra = JSON.stringify({ ...base, limits: [...base.limits, { label: "Mystery pool", percent: 0.3, resetsAt: "" }] });
  const got = parseHostRecord("claude", extra, observed(extra) + 5);
  assert.equal(got.reading.windows.length, 3);
  assert.doesNotMatch(JSON.stringify(got), /Mystery/);
  // A provider only accepts its own windows: Copilot has no session, Claude has no monthly.
  const wrong = JSON.stringify({ ...JSON.parse(await load("copilot")), id: "claude" });
  assert.equal(parseHostRecord("claude", wrong, observed(wrong) + 5).status, "unsupported");
});

test("multi-account records are unavailable rather than guessed", async () => {
  const text = await load("accounts");
  assert.deepEqual(parseHostRecord("claude", text, observed(text) + 5), { status: "unsupported", reading: null, current: false });
});

test("out-of-range, wrong-typed and mismatched records are malformed", async () => {
  const now = observed(await load("claude")) + 5;
  assert.equal(parseHostRecord("claude", await load("out-of-range"), now).status, "malformed");
  assert.equal(parseHostRecord("claude", await load("malformed"), now).status, "malformed");
  const base = JSON.parse(await load("claude"));
  for (const change of [{ limits: [{ label: "Weekly (7-day)", percent: "0.5", resetsAt: "" }] },
    { limits: [{ label: "Weekly (7-day)", percent: -0.1, resetsAt: "" }] },
    { limits: [{ label: "Weekly (7-day)", percent: 0.1, resetsAt: "tomorrow" }] },
    { limits: [{ label: "Weekly (7-day)", percent: 0.1 }] },
    { limits: [{ label: "Weekly (7-day)", percent: 0.1, resetsAt: "" }, { label: "Weekly", percent: 0.2, resetsAt: "" }] },
    { limits: "none" }, { ready: "yes" }, { limitsStale: 0 }, { id: "copilot" }, { accounts: "none" },
    { limitsFetchedAt: 1e20 }]) {
    assert.equal(parseHostRecord("claude", JSON.stringify({ ...base, ...change }), now).status, "malformed", JSON.stringify(change));
  }
  assert.equal(parseHostRecord("claude", "[]", now).status, "malformed");
});

test("fractions never round up to a full window", async () => {
  const base = JSON.parse(await load("claude"));
  const read = (percent) => parseHostRecord("claude", JSON.stringify({ ...base,
    limits: [{ label: "Weekly (7-day)", percent, resetsAt: "" }] }), observed(JSON.stringify(base)) + 5).reading.windows[0].percent;
  assert.deepEqual([0, 0.07, 0.29, 0.5, 0.999, 0.9999999, 1].map(read), [0, 7, 29, 50, 99, 99, 100]);
});

test("an unknown plan label becomes no plan", async () => {
  const base = JSON.parse(await load("claude"));
  const plan = (tierLabel, id = "claude", file = base) => parseHostRecord(id, JSON.stringify({ ...file, id, tierLabel }),
    observed(JSON.stringify(base)) + 5).reading.plan;
  assert.deepEqual(["Max 5x", "max 20x", "Pro", "Mystery tier", 7].map((t) => plan(t)), ["max", "max", "pro", null, null]);
  const agy = JSON.parse(await load("agy"));
  assert.equal(plan("Ultra", "agy", agy), "ultra");
  const copilot = JSON.parse(await load("copilot"));
  assert.deepEqual(["Pro+", "Business", "Enterprise"].map((t) => plan(t, "copilot", copilot)), ["pro+", "business", "enterprise"]);
  assert.equal(plan("Pro 100", "codex", JSON.parse(await load("codex-stale"))), "pro");
});

async function sandbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  return dir;
}

test("the record file is read only when it is a safe, bounded regular file", async (t) => {
  const dir = await sandbox(t);
  const now = observed(await load("claude")) + 5;
  assert.deepEqual(await readHostRecord("claude", now, dir), { status: "unavailable", reading: null, current: false });
  await copyFile(path.join(fixtures, "claude.json"), path.join(dir, "claude.json"));
  assert.equal((await readHostRecord("claude", now, dir)).status, "ok");

  await copyFile(path.join(fixtures, "claude.json"), path.join(dir, "copilot.real"));
  await symlink("copilot.real", path.join(dir, "copilot.json"));
  assert.equal((await readHostRecord("copilot", now, dir)).status, "malformed");

  await writeFile(path.join(dir, "agy.json"), `${JSON.stringify({ schemaVersion: 1, id: "agy", pad: "x".repeat(70 * 1_024) })}\n`);
  assert.equal((await readHostRecord("agy", now, dir)).status, "malformed");

  await writeFile(path.join(dir, "codex.json"), await load("codex-stale"));
  await chmod(path.join(dir, "codex.json"), 0o666);
  assert.equal((await readHostRecord("codex", now, dir)).status, "malformed");

  await rm(path.join(dir, "claude.json"));
  await mkdir(path.join(dir, "claude.json"));
  assert.equal((await readHostRecord("claude", now, dir)).status, "malformed");
});
