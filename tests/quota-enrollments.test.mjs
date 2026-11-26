import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaEnrollmentStore, ENROLLMENT_OBSERVE_MS } from "../mods/insights/fleet-quota/enrollments.mjs";
import { readGrants } from "../mods/insights/fleet-quota/protocol.mjs";

const HOME = "/test/herdr/";
const DIR = "/test/herdr/data/fleet-quota";
const CONFIG = `${DIR}/enrollments.json`;
const generation = (n) => n.toString(16).padStart(32, "0");
const tomb = (n) => `${DIR}/revoked-${generation(n)}.json`;
const record = (n = 1, fields = {}) => ({ version: 1, route: "linux", generation: generation(n),
  coreDigest: "1".repeat(64), binding: "2".repeat(64), enabled: true, providers: ["codex"], ...fields });
const file = (...grants) => JSON.stringify({ version: 1, grants });
const marker = (reason) => `${JSON.stringify({ version: 1, reason })}\n`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const intent = (reason = "route-removed", n = 1) => ({ reason, route: "linux", generation: generation(n) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let now = 0;
  const runtimeGlobal = {};
  const disk = new Map();
  const reads = [];
  const writes = [];
  const safeAsserts = [];
  const f = { disk, reads, writes, safeAsserts, check: false, appHome: HOME,
    read: (path) => disk.get(path) ?? null,
    write: (path, text, expected) => {
      safeAsserts.push(expected === null && path !== CONFIG);
      if (disk.has(path)) throw new Error("private native duplicate");
      disk.set(path, text);
      return null;
    } };
  f.make = (options = {}) => createQuotaEnrollmentStore({
    appHome: () => f.appHome, checking: () => f.check,
    readTextFile: async (path) => { reads.push(path); return f.read(path); },
    writeTextFile: async (path, text, expected) => { writes.push([path, text, expected]); return f.write(path, text, expected); },
    monotonic: () => now, runtimeGlobal, ...options,
  });
  f.advance = (ms = ENROLLMENT_OBSERVE_MS) => { now += ms; };
  return f;
}

test("check mode, a missing file and passive discovery cannot write", async () => {
  const f = fixture();
  const first = f.make();
  f.check = true;
  assert.equal(await first.observe(), null);
  assert.equal(await first.invalidateEnrollment(intent()), false);
  assert.equal(first.readEnrollments(), null);
  assert.deepEqual([f.reads, f.writes], [[], []]);
  f.check = false;
  assert.equal(first.readEnrollments(), null);
  assert.equal(await first.observe(), true);
  assert.deepEqual(first.readEnrollments(), []);
  assert.deepEqual(f.reads, [CONFIG]);
  assert.deepEqual(f.writes, []);
});

test("one native runtime shares a bounded observation and an immutable coordinator snapshot", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record(), record(2, { route: "other", enabled: false })));
  const hold = deferred();
  f.read = (path) => path === CONFIG ? hold.promise : null;
  const first = f.make();
  const second = f.make();
  const a = first.observe();
  const b = second.observe();
  await flush();
  assert.deepEqual(f.reads, [CONFIG]);
  assert.equal(second.readEnrollments(), null);
  hold.resolve(f.disk.get(CONFIG));
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(first.readEnrollments(), second.readEnrollments());
  assert.equal(readGrants(first.readEnrollments()).get("linux").enabled, true);
  assert.throws(() => first.readEnrollments()[0].providers.push("claude"), TypeError);
  assert.deepEqual(f.reads, [CONFIG, tomb(1), CONFIG]);
  assert.equal(await second.observe(), true);
  assert.equal(f.reads.length, 3);
  assert.deepEqual(f.writes, []);
});

test("malformed, unsafe or unreadable config and tombstones fail closed, and valid files can recover", async () => {
  const f = fixture();
  const store = f.make();
  for (const bad of [
    "", "null", "{}", "{" + " ".repeat(65_536) + "}", "not json",
    JSON.stringify({ version: 2, grants: [] }), JSON.stringify({ version: 1, grants: [], path: "/untrusted" }),
    file(record(1, { path: "/untrusted" })), file(record(1, { generation: "../passwd" })),
    file(record(1, { generation: generation(1) + "\n" })), file(record(1, { providers: ["python"] })),
    file(record(), record(1, { route: "other" })), file(record(), record(2)),
    file(...Array.from({ length: 129 }, (_, index) => record(index, { route: `route-${index}` }))),
  ]) {
    f.disk.set(CONFIG, bad);
    assert.equal(await store.observe(), null);
    assert.equal(store.readEnrollments(), null);
    f.advance();
  }
  assert.ok(f.reads.every((path) => path === CONFIG));
  f.disk.set(CONFIG, file(record()));
  assert.equal(await store.observe(), true);
  f.advance();
  f.disk.set(tomb(1), "truncated");
  assert.equal(await store.observe(), null);
  assert.equal(store.readEnrollments(), null);
  f.advance();
  f.read = () => { throw new Error("private native path"); };
  assert.equal(await store.observe(), null);
  assert.equal(await store.invalidateEnrollment(intent("bad reason")), false);
  assert.equal(await store.invalidateEnrollment(null), false);
  assert.equal(store.readEnrollments(), null);
  assert.deepEqual(f.writes, []);
});

test("a successor replaces an abandoned observation after timeout and ignores its late result", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record()));
  const abandoned = deferred();
  const store = f.make({ readTextFile: async () => abandoned.promise });
  const successor = f.make();
  assert.equal(await successor.observe(), true);
  f.advance();
  const pending = store.observe();
  f.advance(ENROLLMENT_OBSERVE_MS - 1);
  const joined = successor.observe();
  assert.equal(successor.readEnrollments()[0].generation, generation(1));
  assert.deepEqual(f.reads, [CONFIG, tomb(1), CONFIG]);

  f.disk.set(CONFIG, file(record(2)));
  f.advance(ENROLLMENT_OBSERVE_MS + 1);
  assert.equal(successor.readEnrollments(), null);
  assert.equal(await successor.observe(), true);
  assert.deepEqual(await Promise.all([pending, joined]), [null, null]);
  assert.equal(successor.readEnrollments()[0].generation, generation(2));

  const reads = f.reads.length;
  abandoned.resolve(file(record()));
  await flush();
  assert.equal(f.reads.length, reads);
  assert.equal(successor.readEnrollments()[0].generation, generation(2));
});

test("a late expired observation cannot clear its still-pending successor's slot", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record()));
  const stale = deferred();
  const next = deferred();
  let starts = 0;
  const read = f.read;
  f.read = (path) => {
    if (path === CONFIG) {
      if (++starts === 1) return stale.promise;
      if (starts === 2) return next.promise;
    }
    return read(path);
  };
  const store = f.make();
  const pending = store.observe();
  f.advance(2 * ENROLLMENT_OBSERVE_MS);
  const recovered = f.make().observe();
  assert.equal(await pending, null);
  stale.resolve(null);
  await flush();
  const joined = store.observe();
  assert.equal(starts, 2);
  next.resolve(f.disk.get(CONFIG));
  assert.deepEqual(await Promise.all([recovered, joined]), [true, true]);
  assert.equal(starts, 3);
});

test("an abandoned writer releases its slot and cannot overwrite a newer grant or tombstone", async () => {
  const f = fixture();
  const other = { route: "other" };
  f.disk.set(CONFIG, file(record(), record(2, other)));
  const hold = deferred();
  const write = f.write;
  const store = f.make({ writeTextFile: async (...args) => {
    f.writes.push(args);
    await hold.promise;
    return write(...args);
  } });
  const successor = f.make();
  assert.equal(await store.observe(), true);
  const pending = store.invalidateEnrollment(intent());
  assert.deepEqual(f.writes, [[tomb(1), marker("route-removed"), null]]);
  assert.equal(await successor.invalidateEnrollment({ ...intent("core-replaced", 2), ...other }), false);
  assert.ok(successor.readEnrollments().every((row) => !row.enabled));

  f.advance();
  assert.equal(await successor.observe(), true);
  assert.equal(f.writes.length, 1);
  f.advance();
  assert.equal(await successor.observe(), true);
  assert.equal(await pending, false);
  await flush();
  assert.equal(f.disk.get(tomb(2)), marker("core-replaced"));

  const replacement = file(record(3), record(2, other));
  f.disk.set(CONFIG, replacement);
  // A separate viewer already committed an immutable marker for the abandoned job.
  f.disk.set(tomb(1), marker("receiver-binding-mismatch"));
  f.advance();
  assert.equal(await successor.observe(), true);
  await flush();
  assert.equal(successor.readEnrollments()[0].generation, generation(3));
  assert.equal(successor.readEnrollments()[0].enabled, true);
  const reads = f.reads.length;
  hold.resolve();
  await flush();
  assert.equal(f.reads.length, reads, "expired native writer does not start read-back");
  assert.equal(f.disk.get(tomb(1)), marker("receiver-binding-mismatch"));
  assert.equal(f.disk.get(CONFIG), replacement);
  assert.ok(f.safeAsserts.every(Boolean));
});

test("late tombstone read-back cannot clear a successor write that is still pending", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record(), record(2, { route: "other" })));
  const oldRead = deferred();
  const nextWrite = deferred();
  const read = f.read;
  let blockReadBack = false;
  const store = f.make({ readTextFile: (path) => blockReadBack && path === tomb(1) ? oldRead.promise : read(path) });
  assert.equal(await store.observe(), true);
  blockReadBack = true;
  const pending = store.invalidateEnrollment(intent());
  await flush();
  assert.equal(f.disk.get(tomb(1)), marker("route-removed"));

  const write = f.write;
  f.write = async (...args) => { await nextWrite.promise; return write(...args); };
  const successor = f.make();
  const other = { ...intent("core-replaced", 2), route: "other" };
  f.advance(2 * ENROLLMENT_OBSERVE_MS);
  const recovered = successor.invalidateEnrollment(other);
  assert.equal(await pending, false);
  oldRead.resolve(marker("route-removed"));
  await flush();
  const joined = successor.invalidateEnrollment(other);
  assert.deepEqual(f.writes.map(([path]) => path), [tomb(1), tomb(2)]);
  nextWrite.resolve();
  assert.deepEqual(await Promise.all([recovered, joined]), [true, true]);
  assert.equal(f.disk.get(tomb(2)), marker("core-replaced"));
});

test("operator replacement during tombstone reads is not published as the old grant", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record()));
  const store = f.make();
  const hold = deferred();
  const read = f.read;
  f.read = (path) => path === tomb(1) ? hold.promise : read(path);
  const observe = store.observe();
  await flush();
  f.disk.set(CONFIG, file(record(2)));
  hold.resolve(null);
  assert.equal(await observe, null);
  assert.equal(store.readEnrollments(), null);
  f.advance();
  assert.equal(await store.observe(), true);
  assert.equal(store.readEnrollments()[0].generation, generation(2));
});

test("tombstone is write-once, read back, and never alters a concurrent new grant", async () => {
  const f = fixture();
  const oldConfig = file(record());
  f.disk.set(CONFIG, oldConfig);
  const store = f.make();
  await store.observe();
  const hold = deferred();
  const write = f.write;
  f.write = async (...args) => { await hold.promise; return write(...args); };
  const one = store.invalidateEnrollment(intent());
  const two = f.make().invalidateEnrollment(intent("core-replaced"));
  assert.equal(store.readEnrollments()[0].enabled, false);
  await flush();
  assert.deepEqual(f.writes, [[tomb(1), marker("route-removed"), null]]);
  assert.equal(f.disk.get(CONFIG), oldConfig);
  const replacement = file(record(2));
  f.disk.set(CONFIG, replacement);
  hold.resolve();
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(f.disk.get(CONFIG), replacement);
  assert.ok(f.reads.includes(tomb(1)));
  f.advance();
  assert.equal(await store.observe(), true);
  assert.equal(store.readEnrollments()[0].enabled, true);
  assert.equal(store.readEnrollments()[0].generation, generation(2));
  assert.equal(await store.invalidateEnrollment(intent()), false);
  f.disk.set(CONFIG, oldConfig);
  const restarted = f.make({ runtimeGlobal: {} });
  await restarted.observe();
  assert.equal(restarted.readEnrollments()[0].invalidated, "route-removed");
  assert.equal(await restarted.invalidateEnrollment(intent()), true);
  assert.equal(f.writes.length, 1);
  assert.ok(f.safeAsserts.every(Boolean));
});

test("a poll whose tombstone read raced revocation cannot restore the invalidated grant", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record()));
  const store = f.make();
  await store.observe();
  f.advance();
  const hold = deferred();
  let intercepted = false;
  const read = f.read;
  f.read = (path) => {
    if (!intercepted && path === tomb(1)) {
      intercepted = true;
      return hold.promise;
    }
    return read(path);
  };
  const pending = store.observe();
  await flush();
  assert.equal(intercepted, true);
  assert.equal(await store.invalidateEnrollment(intent()), true);
  hold.resolve(null);
  await pending;
  assert.equal(store.readEnrollments()[0].enabled, false);
});

test("an unconfirmed write blocks the runtime immediately; a later retry can verify another viewer's tombstone", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record()));
  const store = f.make();
  await store.observe();
  f.write = () => { throw new Error("private native write failure"); };
  assert.equal(await store.invalidateEnrollment(intent()), false);
  assert.equal(store.readEnrollments()[0].enabled, false);
  assert.equal(await store.invalidateEnrollment(intent()), false);
  assert.equal(f.writes.length, 1);
  f.advance();
  f.disk.set(tomb(1), marker("receiver-binding-mismatch"));
  assert.equal(await store.invalidateEnrollment(intent()), true);
  assert.equal(store.readEnrollments()[0].invalidated, "receiver-binding-mismatch");
  assert.equal(JSON.stringify(f.writes).includes(record().binding), false);
});

test("passive observation retries only an earlier failed revocation intent", async () => {
  const f = fixture();
  f.disk.set(CONFIG, file(record(), record(2, { route: "other" })));
  const store = f.make();
  await store.observe();
  const write = f.write;
  f.write = () => { throw new Error("temporarily unavailable"); };
  assert.equal(await store.invalidateEnrollment(intent()), false);
  f.write = write;
  f.advance();
  await store.observe();
  await flush();
  assert.deepEqual(f.writes.map(([path]) => path), [tomb(1), tomb(1)]);
  assert.equal(store.readEnrollments()[0].enabled, false);
  assert.equal(store.readEnrollments()[1].enabled, true);
  const restarted = f.make({ runtimeGlobal: {} });
  await restarted.observe();
  assert.equal(restarted.readEnrollments()[0].enabled, false);
});

test("observation bounds concurrent file reads for the full 128-grant configuration", async () => {
  const f = fixture();
  const size = 128;
  f.disk.set(CONFIG, file(...Array.from({ length: size }, (_, n) => record(n, { route: `remote-${n}` }))));
  let active = 0;
  let peak = 0;
  f.read = async (path) => {
    active++;
    peak = Math.max(peak, active);
    await flush();
    active--;
    return f.disk.get(path) ?? null;
  };
  const store = f.make();
  assert.equal(await store.observe(), true);
  assert.equal(store.readEnrollments().length, size);
  assert.equal(f.reads.length, size + 2);
  assert.equal(peak, 4);
});

test("unsafe app homes and mismatched runtime paths do not start I/O", async () => {
  const f = fixture();
  const store = f.make();
  for (const invalid of ["", "relative", "////", "/test/../other", "/test\npath", "/test/./here"]) {
    f.appHome = invalid;
    assert.equal(await store.observe(), null);
  }
  assert.deepEqual(f.reads, []);
  f.appHome = HOME;
  await store.observe();
  f.appHome = "/another/location";
  assert.equal(await store.observe(), null);
  assert.deepEqual(f.reads, [CONFIG]);
});
