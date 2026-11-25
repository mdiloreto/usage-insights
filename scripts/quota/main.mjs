import { BINDING, withVerifiedGrant } from "./grant.mjs";
import { runQuota } from "./state.mjs";

const [, , operation, provider, binding, ...rest] = process.argv;
if (rest.length || !["read", "refresh"].includes(operation) ||
  !["codex", "claude"].includes(provider) || !BINDING.test(binding)) {
  process.exitCode = 64;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, stop);
  const { report, denial } = await withVerifiedGrant(binding, controller.signal,
    () => runQuota(operation, provider, binding, { signal: controller.signal }));
  const result = report ?? {
    version: 1, provider, status: denial, readAt: Math.floor(Date.now() / 1_000),
    attemptedAt: null, retryAt: null, binding: null, reading: null,
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.off(signal, stop);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
