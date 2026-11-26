// Names each computer in the fleet bar as "<OS> · <name>". Lookups are async, run once per
// machine for the life of the mod, and are read back synchronously so rendering never waits.
export const THIS_COMPUTER = "This Computer";

const MAX_NAME = 32;
const TIMEOUT_MS = 5000;
const OS_BY_PLATFORM = { darwin: "Mac", macos: "Mac", linux: "Linux", win32: "Windows", windows: "Windows" };
const OS_BY_UNAME = [[/^darwin/i, "Mac"], [/^linux/i, "Linux"], [/^(mingw|msys|cygwin)/i, "Windows"]];

export function cleanName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex
  return name === "" || name.length > MAX_NAME || /[\u0000-\u001f\u007f-\u009f@]/.test(name) ? null : name;
}

export const osFromPlatform = (platform) => OS_BY_PLATFORM[platform] ?? null;
export const osFromUname = (text) => OS_BY_UNAME.find(([pattern]) => pattern.test(String(text).trim()))?.[1] ?? null;
export const chipText = (os, name) => (os ? `${os} · ${name}` : name);

export function createIdentity({ exec, platform }) {
  const remoteOs = new Map();
  const asked = new Set();
  let localName = null;
  let localAsked = false;

  const stdout = (result) => (result?.code === 0 ? result.stdout : null);
  const run = (command, args, on) => exec(command, args, on == null ? { timeout: TIMEOUT_MS } : { on, timeout: TIMEOUT_MS }).then(stdout, () => null);

  return {
    snapshot: () => ({
      localOs: osFromPlatform(platform),
      localName,
      remoteOs: (route) => remoteOs.get(route) ?? null,
    }),
    // Starts any lookup not yet attempted; `changed` fires when a new value is learned.
    lookup(routes, changed) {
      if (!localAsked) {
        localAsked = true;
        const mac = osFromPlatform(platform) === "Mac" ? run("scutil", ["--get", "LocalHostName"]) : Promise.resolve(null);
        mac.then((out) => cleanName(out) ?? run("hostname", ["-s"]).then(cleanName)).then((name) => {
          if (name) {
            localName = name;
            changed();
          }
        });
      }
      for (const route of routes) {
        if (asked.has(route)) continue;
        asked.add(route);
        run("uname", ["-s"], route).then((out) => {
          const os = out && osFromUname(out);
          if (os) {
            remoteOs.set(route, os);
            changed();
          }
        });
      }
    },
  };
}
