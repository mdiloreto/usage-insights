import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manageGrant } from "./grant.mjs";
import { directory, homeDirectory } from "./state.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function install() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.platform !== "linux" || major < 22 || (major === 22 && minor < 15)) {
    throw new Error("unsupported runtime");
  }
  const home = await homeDirectory();
  const local = await directory(path.join(home, ".local"), { create: true });
  const bin = await directory(path.join(local, "bin"), { create: true });
  const lib = await directory(path.join(local, "lib"), { create: true });
  const bundle = path.join(lib, "herdr-quota-v1");
  const entry = path.join(bin, "herdr-quota-v1");
  const staging = path.join(bin, `.herdr-quota-${randomBytes(16).toString("hex")}`);

  await mkdir(bundle, { mode: 0o700 }); // Never replace an existing bundle.
  try {
    for (const file of ["frontier", "grant", "main", "normalize", "providers", "runtime", "state"]
      .map((name) => `scripts/quota/${name}.mjs`).concat("mods/insights/core/util.mjs")) {
      const target = path.join(bundle, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(root, file), target);
    }
    await writeFile(path.join(bundle, "grant.lock"), "", { mode: 0o600, flag: "wx" });
    await writeFile(staging, `#!/bin/sh
unset NODE_OPTIONS NODE_PATH NODE_DEBUG
exec ${shellQuote(process.execPath)} "\$HOME/.local/lib/herdr-quota-v1/scripts/quota/main.mjs" "$@"
`, { mode: 0o700, flag: "wx" });
    await link(staging, entry);
  } catch (error) {
    await rm(bundle, { recursive: true, force: true });
    throw error;
  } finally {
    await unlink(staging).catch(() => {});
  }
}

try {
  const [, , operation, ...rest] = process.argv;
  if (rest.length) throw new Error("invalid arguments");
  if (operation === undefined) await install();
  else if (["enroll", "revoke"].includes(operation)) {
    const binding = await manageGrant(operation);
    if (binding !== null) process.stdout.write(`${binding}\n`);
  } else throw new Error("invalid arguments");
} catch {
  process.stderr.write("Quota helper operation refused; check installation and existing Core socket context.\n");
  process.exitCode = 1;
}
