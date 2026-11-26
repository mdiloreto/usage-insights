import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../mods/${file}`, import.meta.url), "utf8");

test("the fleet canary carries byte-identical copies of the Insights quota modules", async () => {
  for (const file of ["fleet-quota/protocol.mjs", "fleet-quota/coordinator.mjs", "quota-projection.mjs"]) {
    assert.equal(await read(`usage-limits-fleet-canary/${file}`), await read(`insights/${file}`), file);
  }
});

test("the canary enrollment store differs only by its private data directory", async () => {
  const insights = await read("insights/fleet-quota/enrollments.mjs");
  const canary = await read("usage-limits-fleet-canary/fleet-quota/enrollments.mjs");
  assert.equal(canary.replace("data/fleet-quota-canary", "data/fleet-quota"), insights);
});
