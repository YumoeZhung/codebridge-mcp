export function loadConfig() {
  return {
    cursorAgentBin: process.env.CURSOR_AGENT_BIN || "cursor-agent",
    opencodeBin: process.env.OPENCODE_BIN || "opencode",
    cursorModel: process.env.CURSOR_MODEL || "",
    opencodeModel: process.env.OPENCODE_MODEL || "",
    sessionStorePath:
      process.env.SESSION_STORE_PATH || "./data/sessions.json",
    defaultTimeoutSeconds: 600,
    killGraceMs: 1500,
  };
}
