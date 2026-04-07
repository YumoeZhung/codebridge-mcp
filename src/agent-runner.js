import { spawn } from "node:child_process";
import readline from "node:readline";

function safeTrim(text) {
  return typeof text === "string" ? text.trim() : "";
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function collectExit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function setupTimeout(child, timeoutMs, killGraceMs) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, killGraceMs);
  }, timeoutMs);
  timer.unref();
  return timer;
}

function cursorApiKeyArgs(config) {
  if (config.cursorApiKey) return ["--api-key", config.cursorApiKey];
  return [];
}

export async function checkCursorAuth(config) {
  if (!config.cursorApiKey) {
    return {
      authenticated: false,
      error:
        "CURSOR_API_KEY is not set. " +
        "Ask the user for their Cursor API key and add it to the MCP server's env configuration. " +
        'You can obtain an API key from: cursor-agent login, or from Cursor Settings > API Keys. ' +
        "Then set CURSOR_API_KEY in the codebridge MCP env block in your agent config file.",
    };
  }

  try {
    const child = spawn(
      config.cursorAgentBin,
      [...cursorApiKeyArgs(config), "--list-models"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    const exitCode = await collectExit(child);
    if (exitCode !== 0) {
      return {
        authenticated: false,
        error: `cursor-agent --list-models failed (exit ${exitCode}): ${safeTrim(stderr) || safeTrim(stdout)}`,
      };
    }
    return { authenticated: true, models: safeTrim(stdout) };
  } catch (err) {
    return { authenticated: false, error: String(err.message || err) };
  }
}

export async function createCursorChat(config, workspace) {
  const child = spawn(
    config.cursorAgentBin,
    [...cursorApiKeyArgs(config), "create-chat"],
    {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await collectExit(child);
  if (exitCode !== 0) {
    throw new Error(
      `cursor-agent create-chat failed (exit ${exitCode}): ${safeTrim(stderr) || safeTrim(stdout) || "unknown error"}`,
    );
  }

  const chatId = safeTrim(stdout);
  if (!chatId) {
    throw new Error("cursor-agent create-chat returned empty chat id");
  }
  return chatId;
}

async function runCursorTurn({ sessionId, prompt, config, workspace, timeoutMs }) {
  const chatId = sessionId || (await createCursorChat(config, workspace));
  const args = [
    ...cursorApiKeyArgs(config),
    "-p", "--output-format", "text", "--force", "--trust",
    "--resume", chatId,
  ];
  if (config.cursorModel) {
    args.push("--model", config.cursorModel);
  }
  args.push(prompt);

  const child = spawn(config.cursorAgentBin, args, {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setupTimeout(child, timeoutMs, config.killGraceMs);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await collectExit(child);
  if (timer) clearTimeout(timer);

  return {
    provider: "cursor",
    sessionId: chatId,
    output: safeTrim(stdout),
    stderr: safeTrim(stderr),
    exitCode: exitCode ?? 0,
  };
}

async function runOpenCodeTurn({ sessionId, prompt, config, workspace, timeoutMs }) {
  const args = ["run", "--format", "json", "--dir", workspace];
  if (config.opencodeModel) {
    args.push("--model", config.opencodeModel);
  }
  if (sessionId) {
    args.push("--session", sessionId);
  }
  args.push(prompt);

  const child = spawn(config.opencodeBin, args, {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setupTimeout(child, timeoutMs, config.killGraceMs);

  let rawStdout = "";
  let stderr = "";
  let nextSessionId = sessionId || null;
  let output = "";

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const event = parseJsonLine(line);
    if (!event) {
      rawStdout += line + "\n";
      return;
    }
    if (event.sessionID) {
      nextSessionId = event.sessionID;
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      output += event.part.text;
    } else {
      rawStdout += line + "\n";
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await collectExit(child);
  rl.close();
  if (timer) clearTimeout(timer);

  return {
    provider: "opencode",
    sessionId: nextSessionId,
    output: safeTrim(output) || safeTrim(rawStdout),
    stderr: safeTrim(stderr),
    exitCode: exitCode ?? 0,
  };
}

export async function runAgentTurn({ provider, sessionId, prompt, config, workspace, timeoutMs }) {
  const effectiveTimeout = timeoutMs ?? config.defaultTimeoutSeconds * 1000;
  switch (provider) {
    case "cursor":
      return runCursorTurn({ sessionId, prompt, config, workspace, timeoutMs: effectiveTimeout });
    case "opencode":
      return runOpenCodeTurn({ sessionId, prompt, config, workspace, timeoutMs: effectiveTimeout });
    default:
      throw new Error(`Unknown provider: ${provider}. Supported: cursor, opencode`);
  }
}
