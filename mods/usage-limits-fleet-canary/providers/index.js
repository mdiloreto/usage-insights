import agy from "./agy.js";
import claude from "./claude.js";
import codex from "./codex.js";
import copilot from "./copilot.js";
import opencode from "./opencode.js";
import pi from "./pi.js";

export const PROVIDERS = [claude, codex, agy, opencode, pi];
export const REMOTE_PROVIDERS = [claude, codex, copilot, agy];
export const ALL_PROVIDERS = [...PROVIDERS, copilot];
export const providerName = (id) => REMOTE_PROVIDERS.find((p) => p.id === id)?.name ?? id;
