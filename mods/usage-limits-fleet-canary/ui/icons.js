// Assets built into Herdr App; a one-color glyph takes the text color. A tag tells apart providers sharing a glyph.
export const PROVIDER_ICONS = {
  claude: { path: "icons/claude.svg" },
  codex: { path: "icons/codex.svg" },
  copilot: { path: "icons/copilot.svg", oneColor: true },
  agy: { path: "icons/antigravity.svg" },
  opencode: { path: "icons/opencode.svg", oneColor: true },
  "opencode-go": { path: "icons/opencode.svg", oneColor: true, tag: "Go" },
  pi: { path: "icons/pi.svg", oneColor: true },
};
