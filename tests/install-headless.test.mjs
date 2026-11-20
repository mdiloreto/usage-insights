import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repo, "scripts/install-headless.sh");
const sourceCollector = path.join(repo, "mods/insights/collector.mjs");
const sourceIndexer = path.join(repo, "mods/insights/indexer.mjs");
const coreDir = path.join(repo, "mods/insights/core");
const SERVICE = "herdr-insights-collect.service";
const TIMER = "herdr-insights-collect.timer";
const TOOLS = [
  "cat",
  "cmp",
  "cp",
  "dirname",
  "install",
  "mkdir",
  "mktemp",
  "rm",
  "sed",
];

function coreNames() {
  return readdirSync(coreDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only the tools the installer needs, so the host's real systemd tools and its
// real node can never be found. systemd-analyze copies the units it verifies.
function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "insights-install-headless-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = path.join(root, "bin");
  const stubs = path.join(root, "stubs");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const tmp = path.join(root, "tmp");
  const verified = path.join(root, "verified");
  for (const dir of [bin, stubs, home, xdg, tmp, verified]) mkdirSync(dir);

  for (const name of TOOLS) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).stdout.trim();
    assert.ok(found, `${name} is needed to run these tests`);
    symlinkSync(found, path.join(bin, name));
  }

  writeFileSync(
    path.join(stubs, "systemd-analyze"),
    [
      "#!/bin/sh",
      'printf \'systemd-analyze %s\\n\' "$*" >> "$STUB_LOG"',
      'if [ "$1" = "--user" ] && [ "$2" = "verify" ]; then',
      "  shift 2",
      '  for f in "$@"; do',
      '    [ -f "$f" ] && cp "$f" "$VERIFIED_DIR/${f##*/}"',
      "  done",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(stubs, "systemctl"),
    ["#!/bin/sh", 'printf \'systemctl %s\\n\' "$*" >> "$STUB_LOG"', "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );

  return {
    root,
    home,
    xdg,
    tmp,
    bin,
    stubs,
    verified,
    log: path.join(root, "stub.log"),
  };
}

function run(sb, args = []) {
  return spawnSync("/bin/sh", [installer, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${sb.stubs}:${sb.bin}`,
      HOME: sb.home,
      XDG_CONFIG_HOME: sb.xdg,
      TMPDIR: sb.tmp,
      STUB_LOG: sb.log,
      VERIFIED_DIR: sb.verified,
      LANG: "C",
    },
  });
}

function calls(sb) {
  return existsSync(sb.log) ? readFileSync(sb.log, "utf8") : "";
}

function tree(dir) {
  const entries = [];
  const walk = (current) => {
    const children = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of children) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isSymbolicLink()) {
        entries.push(`l ${relative} -> ${readlinkSync(full)}`);
      } else if (entry.isDirectory()) {
        entries.push(`d ${relative}`);
        walk(full);
      } else {
        const mode = statSync(full).mode & 0o777;
        entries.push(`f ${relative} ${mode.toString(8)} ${readFileSync(full).toString("base64")}`);
      }
    }
  };
  walk(dir);
  return entries;
}

function fileState(file) {
  const stat = statSync(file);
  return {
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
    data: readFileSync(file, "utf8"),
  };
}

function installedFiles(sb) {
  const share = path.join(sb.home, ".local/share/herdr-insights");
  const units = path.join(sb.xdg, "systemd/user");
  return [
    path.join(share, "collector.mjs"),
    path.join(share, "indexer.mjs"),
    ...coreNames().map((name) => path.join(share, "core", name)),
    path.join(units, SERVICE),
    path.join(units, TIMER),
  ];
}

test("the default run is a read-only report and --check behaves the same", (t) => {
  const sb = sandbox(t);
  const before = tree(sb.home);

  const preview = run(sb);
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.match(preview.stdout, /^install target: .*herdr-insights$/m);
  assert.match(preview.stdout, /^would install: .*collector\.mjs \(mode 0755\)$/m);
  assert.match(preview.stdout, new RegExp(`^would install: .*${SERVICE} \\(mode 0644\\)$`, "m"));
  assert.match(preview.stdout, /^would install: .*herdr-insights-collect\.timer \(mode 0644\)$/m);
  assert.match(
    preview.stdout,
    /^store: .*herdr-app\/data\/insights\/insights\.json \(not created yet\)$/m,
  );
  assert.match(preview.stdout, /^dry run; pass --install to install$/m);
  assert.match(preview.stdout, /^to enable:$/m);
  assert.match(preview.stdout, /systemctl --user enable --now herdr-insights-collect\.timer/);
  assert.match(preview.stdout, /^to uninstall:$/m);
  assert.match(preview.stdout, /never reads credentials and never uploads anything/);
  assert.deepEqual(tree(sb.home), before, "the default run changes nothing");
  assert.deepEqual(readdirSync(sb.tmp), [], "temporary files are cleaned up");
  assert.match(calls(sb), /^systemd-analyze --user verify /m);
  assert.doesNotMatch(calls(sb), /^systemctl /m);

  const check = run(sb, ["--check"]);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /^dry run; pass --install to install$/m);
  assert.deepEqual(tree(sb.home), before, "--check changes nothing");
});

test("--install copies the collector and core modules and writes both units", (t) => {
  const sb = sandbox(t);
  const result = run(sb, ["--install"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const share = path.join(sb.home, ".local/share/herdr-insights");
  const units = path.join(sb.xdg, "systemd/user");
  const installedCollector = path.join(share, "collector.mjs");
  assert.equal(readFileSync(installedCollector, "utf8"), readFileSync(sourceCollector, "utf8"));
  assert.equal(statSync(installedCollector).mode & 0o777, 0o755);
  const installedIndexer = path.join(share, "indexer.mjs");
  assert.equal(readFileSync(installedIndexer, "utf8"), readFileSync(sourceIndexer, "utf8"));
  assert.equal(statSync(installedIndexer).mode & 0o777, 0o644);
  for (const name of coreNames()) {
    const target = path.join(share, "core", name);
    assert.equal(readFileSync(target, "utf8"), readFileSync(path.join(coreDir, name), "utf8"));
    assert.equal(statSync(target).mode & 0o777, 0o644, `${name} mode`);
  }
  assert.equal(
    existsSync(path.join(share, "presenter.mjs")),
    false,
    "the collector does not import presenter.mjs",
  );

  const servicePath = path.join(units, SERVICE);
  const timerPath = path.join(units, TIMER);
  assert.equal(statSync(servicePath).mode & 0o777, 0o644);
  assert.equal(statSync(timerPath).mode & 0o777, 0o644);

  const store = path.join(sb.xdg, "herdr-app/data/insights/insights.json");
  const service = readFileSync(servicePath, "utf8");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^KillMode=process$/m, "the detached indexer survives the pass");
  assert.match(service, /^UMask=0077$/m);
  const timeout = Number(service.match(/^TimeoutStartSec=(\d+)$/m)?.[1]);
  assert.ok(timeout > 0 && timeout <= 3600, "the service timeout is bounded");
  assert.match(
    service,
    new RegExp(
      `^ExecStart=node ${escapeRe(installedCollector)} snapshot --store ${escapeRe(store)} --home ${escapeRe(sb.home)}$`,
      "m",
    ),
  );

  const timer = readFileSync(timerPath, "utf8");
  assert.match(timer, /^OnBootSec=\S+$/m);
  assert.match(timer, /^OnUnitInactiveSec=\S+$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);

  assert.match(calls(sb), /^systemd-analyze --user verify /m);
  const verified = readFileSync(path.join(sb.verified, SERVICE), "utf8");
  assert.match(
    verified,
    new RegExp(`^ExecStart=node ${escapeRe(sourceCollector)} snapshot `, "m"),
    "verification substitutes the not-yet-installed collector",
  );
  assert.doesNotMatch(verified, /@COLLECTOR@/);
});

test("a fresh store reads oh-my-pi sessions only on a host that has them", (t) => {
  const storeSources = (sb) => {
    const store = path.join(sb.xdg, "herdr-app/data/insights/insights.json");
    return JSON.parse(readFileSync(store, "utf8")).config.sources;
  };

  const withOmp = sandbox(t);
  symlinkSync(process.execPath, path.join(withOmp.bin, "node"));
  mkdirSync(path.join(withOmp.home, ".omp/agent/sessions"), { recursive: true });
  const installed = run(withOmp, ["--install"]);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const sources = storeSources(withOmp);
  assert.deepEqual(sources.find((source) => source.id === "omp"), {
    id: "omp",
    label: "oh-my-pi",
    adapter: "pi",
    enabled: true,
    roots: ["~/.omp/agent/sessions"],
  });
  assert.ok(sources.some((source) => source.id === "opencode"), "the defaults are kept");

  const withoutOmp = sandbox(t);
  symlinkSync(process.execPath, path.join(withoutOmp.bin, "node"));
  const plain = run(withoutOmp, ["--install"]);
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.equal(storeSources(withoutOmp).some((source) => source.id === "omp"), false);
});

test("the timer is enabled only with --enable", (t) => {
  const plain = sandbox(t);
  const installed = run(plain, ["--install"]);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.ok(existsSync(path.join(plain.xdg, "systemd/user", TIMER)));
  assert.doesNotMatch(calls(plain), /^systemctl /m);

  const enabled = sandbox(t);
  const result = run(enabled, ["--install", "--enable"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const log = calls(enabled);
  assert.match(log, /^systemctl --user daemon-reload$/m);
  assert.match(log, /^systemctl --user enable --now herdr-insights-collect\.timer$/m);
  assert.ok(
    log.indexOf("daemon-reload") < log.indexOf("enable --now"),
    "daemon-reload runs before enable",
  );
  assert.match(result.stdout, /^enabled: herdr-insights-collect\.timer$/m);
});

test("a second --install leaves every installed file untouched", (t) => {
  const sb = sandbox(t);
  const first = run(sb, ["--install"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);

  const files = installedFiles(sb);
  const before = Object.fromEntries(files.map((file) => [file, fileState(file)]));

  const again = run(sb, ["--install"]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /^already installed; nothing to write$/m);
  assert.doesNotMatch(again.stdout, /^installed:/m);
  assert.match(again.stdout, /^ok \(identical\): /m);
  for (const file of files) {
    assert.deepEqual(fileState(file), before[file], `${file} was not rewritten`);
  }
});

test("a differing target is refused untouched", (t) => {
  const sb = sandbox(t);
  const share = path.join(sb.home, ".local/share/herdr-insights");
  mkdirSync(share, { recursive: true });
  const target = path.join(share, "collector.mjs");
  writeFileSync(target, "locally edited\n", { mode: 0o755 });

  const result = run(sb, ["--install"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^refuse: .*collector\.mjs exists and differs \(upgrade manually\)$/m);
  assert.equal(readFileSync(target, "utf8"), "locally edited\n");
  assert.equal(existsSync(path.join(share, "core")), false);
  assert.equal(existsSync(path.join(sb.xdg, "systemd/user")), false);
});

test("a symlinked target is refused untouched", (t) => {
  const sb = sandbox(t);
  const share = path.join(sb.home, ".local/share/herdr-insights");
  mkdirSync(share, { recursive: true });
  const real = path.join(sb.root, "real-collector.mjs");
  writeFileSync(real, "elsewhere\n");
  const link = path.join(share, "collector.mjs");
  symlinkSync(real, link);

  const result = run(sb, ["--install"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^refuse: .*collector\.mjs is a symlink$/m);
  assert.equal(readlinkSync(link), real);
  assert.equal(readFileSync(real, "utf8"), "elsewhere\n");
  assert.equal(existsSync(path.join(share, "core")), false);
  assert.equal(existsSync(path.join(sb.xdg, "systemd/user")), false);
});

test("--check cannot be combined and --enable requires --install", (t) => {
  const sb = sandbox(t);
  const before = tree(sb.home);

  for (const args of [
    ["--check", "--install"],
    ["--check", "--enable"],
  ]) {
    const result = run(sb, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /--check cannot be combined with --install or --enable/);
  }

  const enableAlone = run(sb, ["--enable"]);
  assert.equal(enableAlone.status, 2, enableAlone.stdout);
  assert.match(enableAlone.stderr, /--enable requires --install/);

  assert.deepEqual(tree(sb.home), before);
  assert.equal(calls(sb), "", "nothing is verified or enabled");
});
