import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontierCredit, parseUsageWindows } from "../scripts/quota/frontier.mjs";

const time = (value) => Date.parse(value) / 1_000;
const readAt = time("2026-11-23T12:00:00Z");
const reset = "Dec 16, 12:22pm (America/Argentina/Buenos_Aires)";
const screen = (percent, date = reset) => ` Settings
   Frontier model credit
   ▏━━━━━━━━━  ${percent}% used
   $278.99 of $20,000 used · Resets ${date}
   Esc to cancel
`;

test("frontier parser keeps the reported percent, exact cents with the $ unit and explicit timezone", () => {
  for (const percent of [0, 1, 100]) {
    assert.deepEqual(parseFrontierCredit(screen(percent), readAt), {
      id: "frontier_credit", short: "Frontier credit", long: "Frontier credit",
      percent, resetsAt: time("2026-12-16T15:22:00Z"), durationSec: null,
      money: { currency: "$", usedMinor: 27_899, limitMinor: 2_000_000 },
    });
  }
});

test("frontier parser is bounded and rejects stale, unavailable, duplicate and noncanonical UI", () => {
  for (const contents of ["", "No usage data", "x".repeat(64 * 1024) + screen(1), screen(101), screen(1.5),
    screen(1).replace("Frontier model credit", "Extra usage credit"),
    screen(1).replace("$278.99", "278.99"), screen(1).replace("▏━━━━━━━━━", "other quota"),
    screen(1).replace("$278.99", "$0278.99"), screen(1).replace("$20,000", "$0"),
    screen(1).replace("$20,000", "$200,00"), screen(1).replace("$20,000", "Unlimited"),
    screen(1) + screen(1), "Last known usage\n" + screen(1), "Cached data\n" + screen(1),
    "Failed to load usage\n" + screen(1), "Trust this folder?\n" + screen(1)]) {
    assert.equal(parseFrontierCredit(contents, readAt), null);
  }
});

test("frontier reset needs a unique future round trip near the observation across local New Year", () => {
  assert.equal(parseFrontierCredit(screen(1, "Jan 1, 12:10am (America/Los_Angeles)"),
    time("2027-01-01T04:00:00Z")).resetsAt, time("2027-01-01T08:10:00Z"));
  assert.equal(parseFrontierCredit(screen(1, "Jan 1, 12:10am (Pacific/Kiritimati)"),
    time("2026-12-31T08:00:00Z")).resetsAt, time("2026-12-31T10:10:00Z"));
  for (const [date, now] of [
    ["Nov 22, 1:00pm (UTC)", readAt],
    ["Nov 23, 12:00pm (UTC)", readAt],
    ["Mar 1, 12:00pm (UTC)", readAt],
    ["Nov 31, 1:00pm (UTC)", readAt],
    ["Dec 16, 13:22pm (UTC)", readAt],
    ["Dec 16, 12:60pm (UTC)", readAt],
    ["Dec 16, 12:22pm (America/Nowhere)", readAt],
    ["Dec 16, 12:22pm (EST)", readAt],
    ["Dec 16, 12:22pm", readAt],
    ["Mar 14, 2:30am (America/New_York)", time("2027-03-13T12:00:00Z")],
    ["Nov 1, 1:30am (America/New_York)", time("2026-10-31T12:00:00Z")],
  ]) {
    assert.equal(parseFrontierCredit(screen(1, date), now), null, date);
  }
});

const monthly = (percent = 88, spent = "$531.73 / $600 spent · Resets Dec 1") =>
  `  Usage credits\n  ▏━━━━━━━━━  ${percent}% used\n  ${spent}\n`;

test("monthly parser keeps the reported percent, exact cents with the $ unit and date without inventing an instant", () => {
  for (const percent of [0, 88, 100]) {
    for (const [date, resetLabel] of [["Dec 1", "Dec 1"], ["Dec 1 (America/Argentina/Buenos_Aires)", "Dec 1"],
      ["Dec 1, 2027 (UTC)", "Dec 1, 2027"]]) {
      const expected = { id: "monthly_spend_limit", short: "Monthly usage credits", long: "Monthly usage credits",
        percent, resetsAt: null, durationSec: null, money: { currency: "$", usedMinor: 53_173, limitMinor: 60_000, resetLabel } };
      const usage = monthly(percent, `$531.73 / $600.00 spent · Resets ${date}`);
      assert.deepEqual(parseUsageWindows(usage, readAt), [expected]);
      assert.deepEqual(parseUsageWindows(usage + screen(1), readAt), [parseFrontierCredit(screen(1), readAt), expected]);
    }
  }
  const atLimit = monthly(100, "$0 / $90,071,992,547,409.91 spent · Resets Feb 29");
  assert.deepEqual(parseUsageWindows(atLimit, readAt)[0].money,
    { currency: "$", usedMinor: 0, limitMinor: Number.MAX_SAFE_INTEGER, resetLabel: "Feb 29" });
  assert.equal(parseUsageWindows(monthly() + screen(1, "Dec 16, 12:22pm"), readAt)[0].id, "monthly_spend_limit");
});

test("monthly parser rejects ambiguous or uncapped rows without suppressing independent Frontier evidence", () => {
  for (const usage of ["", monthly(101), monthly("88.5"), monthly().replace("Usage credits", "Claude Code and Cowork credit"),
    monthly(88, "$531.73 spent · Resets Dec 1"), monthly(88, "$531.73 / Unlimited spent · Resets Dec 1"),
    monthly(88, "$531.73 / $0.00 spent · Resets Dec 1"), monthly(88, "$531.73 / $Infinity spent · Resets Dec 1"),
    monthly(88, "$531.73 / $90,071,992,547,409.92 spent · Resets Dec 1"),
    monthly(88, "$0.001 / $600 spent · Resets Dec 1"), monthly(88, "$0.1 / $600 spent · Resets Dec 1"),
    monthly(88, "$001.01 / $600 spent · Resets Dec 1"), monthly(88, "$1,00.00 / $600 spent · Resets Dec 1"),
    monthly(88, "€531.73 / €600 spent · Resets Dec 1"), monthly(88, "$531.73 / $600 spent"),
    monthly(88, "$531.73 / $600 spent · Resets Feb 30"),
    monthly(88, "$531.73 / $600 spent · Resets Feb 29, 2027"),
    monthly(88, "$531.73 / $600 spent · Resets Dec 1, 12:00am (UTC)"),
    monthly(88, "$531.73 / $600 spent · Resets Dec 1 (+03:00)"),
    monthly(88, "$531.73 / $600 spent · Resets Dec 1 (EST)"),
    monthly(88, "$531.73 / $600 spent · Resets Dec 1 (America/Nowhere)"),
    "  Usage credits\n  Disabled\n", "  Usage credits\n  $600 balance\n",
    monthly() + "\n  Usage credits\n  No monthly cap\n"]) {
    assert.deepEqual(parseUsageWindows(usage, readAt), []);
    assert.deepEqual(parseUsageWindows(screen(1) + usage, readAt), [parseFrontierCredit(screen(1), readAt)]);
  }
  for (const banner of ["No usage data", "Refreshing usage…", "Showing last-known usage", "Couldn't refresh usage data"]) {
    assert.deepEqual(parseUsageWindows(screen(1) + monthly() + `  ${banner}\n`, readAt), []);
  }
});
