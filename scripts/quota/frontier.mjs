import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { FRONTIER_MAX_RESET, MONTHS, epoch, validResetLabel } from "./normalize.mjs";
import { ProbeError } from "./runtime.mjs";

const MAX_CONFIG = 4_096;
const MAX_SCREEN = 64 * 1024;
const WALL_TIME = { year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const utc = new Intl.DateTimeFormat("en-CA", { ...WALL_TIME, timeZone: "UTC" });
const blocked = /trust this folder|trust the files|I trust|security guide|quick safety check|select login method|log in to claude code|please log in|choose login method|choose the text style|select a theme/i;
const unavailable = /\b(?:cached|stale|last[ -]known|too many requests|rate[ -]limited|no usage data)\b|(?:failed|could not|unable) to (?:load|fetch) usage|\bcouldn['’]t (?:load|refresh) usage data\b/i;
const pendingUsage = /(?:^ *|: *)(?:loading(?: usage(?: data)?)?|refreshing usage|retry(?:ing)?(?: usage(?: data)?)?|try again(?: (?:shortly|later|in\b[^\n]*))?) *[.!…]* *$/im;
const rateLimitLabel = /(?:^ *|: *)(?:rate[ -]limited|too many requests)(?= *(?:[.!,:;–—(-]|$))/im;
const explicit429 = /(?:^ *|: *)(?:(?:HTTP(?:\/[12](?:\.\d)?)?|status(?: code)?|error)(?: *: *| +)429(?!\.\d)|429 +too many requests)(?= *(?:[.!,:;–—(-]|$)| +too many requests\b)/im;
// The usage panel can wrap a banner across terminal rows.
const pageClock = String.raw`(?:[1-9]|1[0-2]):[0-5]\d(?:am|pm)`;
const pageRateLimit = new RegExp(`^ *(?:${
  [String.raw`The usage page is (?:rate limited (?:until ${pageClock}|— try again in a moment)|requests temporarily limited — try again in a moment)\.`,
    String.raw`Claude is temporarily limiting requests to the usage page \(not your usage limit\)\. Try again in a moment\.`,
    String.raw`Showing last-known usage \(rate limited until ${pageClock}\)`].join("|").replaceAll(" ", "[ \\n]+")
}) *$`, "im");
const horizontalSpaces = (text) => text.replace(/[\p{Zs}\t]/gu, " ");
const dollars = String.raw`\$(?:0|[1-9]\d{0,13}|[1-9]\d{0,2}(?:,\d{3}){1,4})`;
const usd = String.raw`${dollars}(?:\.\d{2})?`;
const percentRow = String.raw` *[█-▟■□━─░▒▓▰▱]* *(0|[1-9]\d?|100) *% used *`;
const zoneName = String.raw`UTC|[A-Za-z][\w+-]*(?:\/[A-Za-z][\w+-]*){1,3}`;
const credit = new RegExp(String.raw`^ *Frontier model credit *\n${percentRow}\n *(${dollars}\.\d{2}) of (${usd}) used · Resets ([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})(am|pm) \((${zoneName})\) *$`, "m");
const monthlyCredit = new RegExp(String.raw`^ *Usage credits *\n${percentRow}\n *(${usd}) +/ +(${usd}) +spent +· +Resets +(${MONTHS.join("|")}) +(\d{1,2})(?:, +(\d{4}))?(?: +\((${zoneName})\))? *$`, "m");

function money(used, cap) {
  const cents = (value) => {
    const [whole, fraction = "00"] = value.slice(1).replaceAll(",", "").split(".");
    return Number(whole + fraction);
  };
  const usedMinor = cents(used);
  const limitMinor = cents(cap);
  // The panel shows a $ unit, not an ISO currency code.
  return Number.isSafeInteger(usedMinor) && Number.isSafeInteger(limitMinor) && limitMinor > 0
    ? { currency: "$", usedMinor, limitMinor } : null;
}

const privateFile = (info) => info.isFile() && info.uid === process.geteuid() &&
  info.nlink === 1 && (info.mode & 0o777) === 0o600 && info.size <= MAX_CONFIG;
const cwdField = String.raw`"cwd"\s*:\s*"(?:[^"\\]|\\.)*"`;
const modeField = String.raw`"mode"\s*:\s*"frontier-only"`;
const sidecarShape = new RegExp(String.raw`^\s*\{\s*(?:${cwdField}(?:\s*,\s*${modeField})?|${modeField}\s*,\s*${cwdField})\s*\}\s*$`, "u");

export async function frontierConfig(stateDir) {
  const file = path.join(stateDir, "claude-frontier-workspace.json");
  let config;
  try {
    const info = await lstat(file);
    if (!privateFile(info)) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!privateFile(current) || current.dev !== info.dev || current.ino !== info.ino) return null;
      const buffer = Buffer.alloc(MAX_CONFIG + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_CONFIG) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (!sidecarShape.test(text)) return null;
      config = JSON.parse(text);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const { cwd, mode } = config;
  try {
    if (cwd !== "/" && path.isAbsolute(cwd) && path.resolve(cwd) === cwd &&
      !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(cwd)) {
      const dir = await lstat(cwd);
      if (dir.isDirectory() && dir.uid === process.geteuid() && (dir.mode & 0o022) === 0 &&
        await realpath(cwd) === cwd) return { cwd, mode };
    }
  } catch { /* Missing or unreadable workspace. */ }
  // A recognized explicit mode never falls back to a headless fetch, even with a bad workspace.
  return mode === "frontier-only" ? { cwd: null, mode } : null;
}

function resetTime([month, day, hour, minute, meridiem, zone], now) {
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0 || +day < 1 || +day > 31 || +hour < 1 || +hour > 12 || +minute > 59) return null;
  let zoned;
  try { zoned = new Intl.DateTimeFormat("en-CA", { ...WALL_TIME, timeZone: zone }); }
  catch { return null; }
  const localYear = Number(zoned.formatToParts(now * 1_000).find(({ type }) => type === "year").value);
  const max = now + FRONTIER_MAX_RESET;
  for (const year of [localYear, localYear + 1]) {
    const wall = Date.UTC(year, monthIndex, +day, +hour % 12 + (meridiem === "pm" ? 12 : 0), +minute);
    if (new Date(wall).getUTCMonth() !== monthIndex ||
      wall / 1_000 + 86_400 <= now || wall / 1_000 - 86_400 > max) continue;
    const expected = utc.format(wall);
    let found = null;
    // Check all minute offsets, including both sides of a daylight-saving overlap.
    for (let offset = -86_400; offset <= 86_400; offset += 60) {
      const instant = wall / 1_000 + offset;
      if (zoned.format(instant * 1_000) !== expected) continue;
      if (found !== null) return null;
      found = instant;
    }
    if (found > now && found <= max) return found;
  }
  return null;
}

function settledScreen(screen, observedAt) {
  if (typeof screen !== "string" || Buffer.byteLength(screen) > MAX_SCREEN || !epoch(observedAt)) return null;
  const text = horizontalSpaces(screen);
  return blocked.test(text) || unavailable.test(text) || pendingUsage.test(text) ||
    pageRateLimit.test(text) || explicit429.test(text) ? null : text;
}

function frontierWindow(screen, observedAt) {
  if ([...screen.matchAll(/^ *Frontier model credit *$/gim)].length !== 1) return null;
  const match = credit.exec(screen);
  if (!match) return null;
  const [, usedPercent, used, cap, ...reset] = match;
  const amount = money(used, cap);
  if (!amount) return null;
  const resetsAt = resetTime(reset, observedAt);
  return resetsAt === null ? null : {
    id: "frontier_credit", short: "Frontier credit", long: "Frontier credit",
    percent: Number(usedPercent), resetsAt, durationSec: null, money: amount,
  };
}

export function parseFrontierCredit(screen, observedAt) {
  const text = settledScreen(screen, observedAt);
  return text === null ? null : frontierWindow(text, observedAt);
}

function monthlyWindow(screen) {
  if ([...screen.matchAll(/^ *Usage credits *$/gim)].length !== 1) return null;
  const match = monthlyCredit.exec(screen);
  if (!match) return null;
  const [, usedPercent, used, cap, month, day, year, zone] = match;
  const amount = money(used, cap);
  const resetLabel = `${month} ${day}${year ? `, ${year}` : ""}`;
  if (!amount || !validResetLabel(resetLabel)) return null;
  if (zone) {
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); }
    catch { return null; }
  }
  return { id: "monthly_spend_limit", short: "Monthly usage credits", long: "Monthly usage credits",
    percent: Number(usedPercent), resetsAt: null, durationSec: null, money: { ...amount, resetLabel } };
}

export function parseUsageWindows(screen, observedAt) {
  const text = settledScreen(screen, observedAt);
  if (text === null) return [];
  return [frontierWindow(text, observedAt), monthlyWindow(text)].filter(Boolean);
}

function prompt(screen, command = "") {
  const lines = horizontalSpaces(screen).split("\n");
  const prompts = lines.filter((line) => line.startsWith("❯"));
  if (prompts.length !== 1 || prompts[0].slice(1).replace(/^ +| +$/g, "") !== command) return false;
  const highlighted = lines.filter((line) => /^ +❯/.test(line));
  if (command === "") return highlighted.length === 0;
  return highlighted.length === 1 && /^ +❯ +\/usage +\S/.test(highlighted[0]) &&
    /\b(?:usage|limits?|plan|rate|cost)\b/i.test(highlighted[0].replace(/^ +❯ +\/usage +/, ""));
}

export async function claudeFrontier(executable, context, { includeMonthly = false } = {}) {
  // Reserve time for terminal cleanup and the final identity check.
  const end = context.deadline - 1_500;
  if (context.signal?.aborted || performance.now() >= end) return null;
  const dir = await mkdtemp("/tmp/herdr-claude-");
  const socket = path.join(dir, "tmux.sock");
  const tmuxArgs = ["-S", socket, "-f", "/dev/null"];
  const target = "usage:0.0";
  const options = { cwd: context.cwd, env: context.env };
  let server;
  let paneStarted = false;
  const tmux = (args, deadline = end) => {
    const remaining = deadline - performance.now();
    if (remaining < 1) return null;
    const result = spawnSync("/usr/bin/tmux", [...tmuxArgs, "-N", ...args], {
      ...options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_SCREEN, timeout: Math.min(500, Math.floor(remaining)), killSignal: "SIGKILL",
    });
    return result.status === 0 ? result.stdout : null;
  };
  const waitFor = async (read, until) => {
    while (!context.signal?.aborted && performance.now() < until) {
      const value = read();
      if (value !== undefined) return value;
      if (server.exitCode !== null || server.signalCode !== null || !server.pid) return null;
      await delay(Math.min(100, Math.max(0, until - performance.now())));
    }
    return null;
  };
  const waitScreen = (check, ms, submitted = false) => waitFor(() => {
    const screen = tmux(["capture-pane", "-p", "-t", target]);
    if (screen === null) return null;
    const text = horizontalSpaces(screen);
    if (blocked.test(text)) return null;
    const throttled = pageRateLimit.test(text) || explicit429.test(text);
    if (submitted && (throttled || (!/\bno usage data\b/i.test(text) && rateLimitLabel.test(text)))) {
      throw new ProbeError("rate-limited");
    }
    // Only post-submit frames may be provisional. Never parse a mixed frame as fresh credit.
    if (throttled) return null;
    if (unavailable.test(text) || (submitted && pendingUsage.test(text))) return submitted ? undefined : null;
    return check(screen);
  }, Math.min(end, performance.now() + ms));

  try {
    server = spawn("/usr/bin/tmux", [...tmuxArgs, "-D"], { ...options, stdio: "ignore" });
    server.on("error", () => {});
    if (!await waitFor(() => tmux(["show-options", "-gv", "default-shell"]) === null ? undefined : true,
      Math.min(end, performance.now() + 750))) return null;
    paneStarted = true;
    // Multiple command arguments are exec'd directly; cwd is never parsed as tmux format or shell input.
    if (tmux(["new-session", "-d", "-x", "114", "-y", "38", "-s", "usage",
      "--", executable, "--safe-mode", "--tools", "", "--no-chrome"]) === null) return null;
    if (!await waitScreen((screen) => prompt(screen) || undefined, 7_800) || context.signal?.aborted) return null;
    if (tmux(["send-keys", "-t", target, "-l", "/usage"]) === null) return null;
    if (!await waitScreen((screen) => prompt(screen, "/usage") || undefined, 2_600) ||
      context.signal?.aborted) return null;
    if (tmux(["send-keys", "-t", target, "Enter"]) === null) return null;
    return await waitScreen((screen) => {
      const observedAt = Math.floor(Date.now() / 1_000);
      const windows = includeMonthly ? parseUsageWindows(screen, observedAt) :
        [parseFrontierCredit(screen, observedAt)].filter(Boolean);
      return windows.length ? { observedAt, windows } : undefined;
    }, 9_800, true);
  } finally {
    if (paneStarted) {
      const pid = tmux(["list-panes", "-t", "=usage", "-F", "#{pane_pid}"], context.deadline - 1_200)?.trim();
      if (/^[1-9]\d{1,8}$/.test(pid ?? "")) {
        try { process.kill(-Number(pid), "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    server?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}
