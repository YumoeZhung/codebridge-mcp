import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runAgentTurn } from "./agent-runner.js";
import {
  captureSnapshot,
  summarizeChanges,
  currentDiff,
} from "./workspace-diff.js";
import { SessionStore } from "./session-store.js";

const config = loadConfig();
const store = new SessionStore(config.sessionStorePath);

const COMPLETION_PATTERN = /^TASK_COMPLETE/im;

const CONTINUE_PROMPT = [
  "Review the current state of the project.",
  "If there are remaining tasks from the original goal, continue working on them.",
  "If all tasks are completed, start your response with TASK_COMPLETE followed by a brief summary.",
].join(" ");

const server = new McpServer({
  name: "codebridge-mcp",
  version: "0.1.0",
});

// ─── Tool 1: run_code_agent ────────────────────────────────────────────

server.tool(
  "run_code_agent",
  "Run a single turn of a coding agent (cursor-agent or opencode). " +
    "Blocks until the CLI process exits, then returns the full output. " +
    "Use session_id from a previous call to continue the same conversation.",
  {
    provider: z.enum(["cursor", "opencode"]).describe("Which coding CLI to use"),
    prompt: z.string().describe("The instruction to send to the coding agent"),
    workspace: z.string().describe("Absolute path to the project directory"),
    session_id: z
      .string()
      .optional()
      .describe("Session ID from a previous run to resume the conversation"),
    model: z.string().optional().describe("Override the default model"),
    timeout_seconds: z
      .number()
      .optional()
      .describe("Timeout in seconds (default 600). Process is killed after this."),
  },
  async (params) => {
    const timeoutMs = (params.timeout_seconds ?? config.defaultTimeoutSeconds) * 1000;
    const sessionId =
      params.session_id || (await store.getSessionId(params.provider, params.workspace));

    const effectiveConfig = {
      ...config,
      ...(params.model && params.provider === "cursor"
        ? { cursorModel: params.model }
        : {}),
      ...(params.model && params.provider === "opencode"
        ? { opencodeModel: params.model }
        : {}),
    };

    const beforeSnapshot = await captureSnapshot(params.workspace);

    const started = Date.now();
    const result = await runAgentTurn({
      provider: params.provider,
      sessionId,
      prompt: params.prompt,
      config: effectiveConfig,
      workspace: params.workspace,
      timeoutMs,
    });
    const durationMs = Date.now() - started;

    if (result.sessionId) {
      await store.setSessionId(params.provider, params.workspace, result.sessionId);
    }

    const afterSnapshot = await captureSnapshot(params.workspace);
    const diff = await summarizeChanges(beforeSnapshot, afterSnapshot);

    const response = {
      output: result.output,
      session_id: result.sessionId || "",
      exit_code: result.exitCode,
      duration_ms: durationMs,
      diff: {
        summary: diff.summary,
        changed_files: diff.changedFiles,
        branch: afterSnapshot.branch || "",
        head_before: beforeSnapshot.head || "",
        head_after: afterSnapshot.head || "",
      },
    };

    if (result.exitCode !== 0) {
      const errDetail = result.stderr || result.output || "Process exited with non-zero code";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ...response, error: errDetail },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    };
  },
);

// ─── Tool 2: run_code_loop ─────────────────────────────────────────────

server.tool(
  "run_code_loop",
  "Run an autonomous coding loop: sends a goal to a coding agent, " +
    "then continues sending follow-up prompts until the agent signals TASK_COMPLETE " +
    "or max_turns is reached. Each turn blocks until the CLI exits. " +
    "WARNING: This single tool call blocks for the entire loop duration.",
  {
    provider: z.enum(["cursor", "opencode"]).describe("Which coding CLI to use"),
    goal: z.string().describe("High-level goal for the coding agent"),
    workspace: z.string().describe("Absolute path to the project directory"),
    max_turns: z
      .number()
      .optional()
      .describe("Maximum number of turns (default 10)"),
    session_id: z
      .string()
      .optional()
      .describe("Session ID to resume from"),
    timeout_seconds_per_turn: z
      .number()
      .optional()
      .describe("Timeout per turn in seconds (default 600)"),
  },
  async (params) => {
    const maxTurns = params.max_turns ?? 10;
    const timeoutMs =
      (params.timeout_seconds_per_turn ?? config.defaultTimeoutSeconds) * 1000;
    let sessionId =
      params.session_id || (await store.getSessionId(params.provider, params.workspace));

    const effectiveConfig = { ...config };
    const initialSnapshot = await captureSnapshot(params.workspace);
    const turns = [];
    let completed = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const prompt = turn === 1 ? params.goal : CONTINUE_PROMPT;
      const beforeSnapshot = await captureSnapshot(params.workspace);

      const started = Date.now();
      let result;
      try {
        result = await runAgentTurn({
          provider: params.provider,
          sessionId,
          prompt,
          config: effectiveConfig,
          workspace: params.workspace,
          timeoutMs,
        });
      } catch (err) {
        turns.push({
          turn_number: turn,
          prompt,
          output: "",
          error: String(err.message || err),
          diff_summary: "",
          duration_ms: Date.now() - started,
          exit_code: -1,
        });
        break;
      }
      const durationMs = Date.now() - started;

      if (result.sessionId) {
        sessionId = result.sessionId;
        await store.setSessionId(params.provider, params.workspace, sessionId);
      }

      const afterSnapshot = await captureSnapshot(params.workspace);
      const diff = await summarizeChanges(beforeSnapshot, afterSnapshot);

      turns.push({
        turn_number: turn,
        prompt,
        output: result.output,
        diff_summary: diff.summary,
        duration_ms: durationMs,
        exit_code: result.exitCode,
      });

      if (result.exitCode !== 0) break;

      if (COMPLETION_PATTERN.test(result.output)) {
        completed = true;
        break;
      }
    }

    const finalSnapshot = await captureSnapshot(params.workspace);
    const finalDiff = await summarizeChanges(initialSnapshot, finalSnapshot);

    const response = {
      turns,
      completed,
      total_turns: turns.length,
      session_id: sessionId || "",
      final_diff: {
        summary: finalDiff.summary,
        changed_files: finalDiff.changedFiles,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    };
  },
);

// ─── Tool 3: workspace_diff ────────────────────────────────────────────

server.tool(
  "workspace_diff",
  "Get the current git diff summary for a workspace. Shows uncommitted changes, branch, and HEAD.",
  {
    workspace: z.string().describe("Absolute path to the project directory"),
  },
  async (params) => {
    const diff = await currentDiff(params.workspace);
    return {
      content: [{ type: "text", text: JSON.stringify(diff, null, 2) }],
    };
  },
);

// ─── Start ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
