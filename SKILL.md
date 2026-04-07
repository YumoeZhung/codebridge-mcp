---
name: codebridge
description: Drive coding CLIs (cursor-agent, opencode) from any agent with shell access. Use when the task requires invoking a separate coding agent to write, fix, refactor, or analyze code in a project workspace. Triggers on requests involving cursor-agent, opencode, code agent delegation, autonomous coding loops, or multi-turn coding workflows.
---

# CodeBridge

Drive cursor-agent and opencode from any agent with shell access. No MCP server, no extra dependencies — just CLI invocations.

## Authentication (read before first use)

### cursor-agent

Requires `CURSOR_API_KEY`. No browser login needed.

Verify authentication:

```bash
CURSOR_API_KEY=key_xxx cursor-agent --list-models
```

If `CURSOR_API_KEY` is not available in your environment, ask the user to provide one. The user can obtain it from Cursor Settings > API Keys, or by running `cursor-agent login` on a machine with a browser and then checking `cursor-agent status`.

Once you have the key, pass it via environment variable or `--api-key` flag on every invocation.

### opencode

Uses its own auth system. Verify with:

```bash
opencode models
```

If not authenticated, run `opencode auth` and follow the prompts (requires user interaction).

## CLI Command Reference

### cursor-agent: non-interactive mode

Single-turn execution — run a prompt, block until the agent finishes, read stdout:

```bash
CURSOR_API_KEY=key_xxx cursor-agent \
  -p \
  --force \
  --trust \
  --workspace /path/to/project \
  "your prompt here"
```

Flag breakdown:
- `-p` (print mode): non-interactive, outputs to stdout, exits when done
- `--force`: auto-approve tool calls (file writes, shell commands)
- `--trust`: skip workspace trust prompt in headless mode
- `--workspace <path>`: target project directory

Optional flags:
- `--model <model>`: override default model (e.g. `sonnet-4-thinking`, `gpt-5`)
- `--output-format text|json|stream-json`: output format (default: `text`)
- `--mode plan`: read-only planning mode (no file edits)
- `--mode ask`: Q&A mode (no file edits)
- `-w, --worktree [name]`: run in an isolated git worktree

### cursor-agent: session management

Create a new chat session:

```bash
CURSOR_API_KEY=key_xxx cursor-agent create-chat
# outputs a chat UUID
```

Resume a session (preserves full conversation context):

```bash
CURSOR_API_KEY=key_xxx cursor-agent \
  -p --force --trust \
  --resume <chatId> \
  "continue with the next step"
```

Continue the most recent session:

```bash
CURSOR_API_KEY=key_xxx cursor-agent \
  -p --force --trust \
  --continue \
  "fix the test failures from last round"
```

### opencode: non-interactive mode

```bash
opencode run \
  --dir /path/to/project \
  "your prompt here"
```

Optional flags:
- `-m, --model provider/model`: specify model (e.g. `anthropic/sonnet-4`)
- `-s, --session <id>`: resume a specific session
- `-c, --continue`: continue the most recent session
- `-f, --file <path>`: attach file(s) for context
- `--agent <name>`: use a specific agent profile
- `--format json`: output raw JSON events instead of formatted text

## Usage Patterns

### Pattern 1: SubAgent sync loop (OpenClaw / DeskClaw)

Recommended when the agent must stay responsive to the user while coding runs in the background.

The main agent spawns a subAgent to handle the coding loop. The subAgent calls cursor-agent synchronously — each invocation blocks until cursor-agent exits, then the subAgent analyzes the result and decides the next step. The main agent is free to handle messages.

**OpenClaw:**

```
sessions_spawn({
  task: "Use cursor-agent to implement user registration for /path/to/project. \
    Run cursor-agent -p with CURSOR_API_KEY=<key>. After each round, review \
    the result and decide next steps. Send a Feishu notification after each round. \
    When all steps are complete, summarize what was done.",
  runTimeoutSeconds: 3600
})
```

**DeskClaw (nanobot):**

Same `sessions_spawn` call. Ensure `agents.defaults.subagents` config allows sufficient timeout:

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "runTimeoutSeconds": 3600,
        "maxSpawnDepth": 1
      }
    }
  }
}
```

**SubAgent internal loop (pseudocode):**

```
chatId = exec("cursor-agent create-chat")

while task not complete:
    result = exec("cursor-agent -p --force --trust --resume <chatId> '<next prompt>'")
    analyze result
    send progress notification
    if done: break
    formulate next prompt

announce final summary to parent agent
```

The key advantage: each `exec` call is synchronous. No heartbeat, no event routing, no background process management. Process exit = result available.

### Pattern 2: Direct execution (Cursor / single-agent)

When the agent itself has shell access and doesn't need to stay responsive during coding:

```bash
cursor-agent -p --force --trust --workspace /path/to/project "implement the feature"
```

Read the stdout output, analyze it, decide whether to run another round. The agent controls the loop directly.

### Pattern 3: Human-guided loop

Each round completes, the agent reports results to the human, waits for the next instruction before continuing. Suitable for tasks requiring human review between steps.

```
Round 1: exec cursor-agent → report result to user
User: "looks good, now add tests"
Round 2: exec cursor-agent --resume <chatId> "add tests" → report result
User: "done"
```

## Error Handling

### Common errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` / `Unauthorized` | Invalid or missing API key | Verify `CURSOR_API_KEY`; ask user for a valid key |
| `Workspace Trust Required` | Missing `--trust` flag | Add `--trust` to the command |
| Process hangs indefinitely | Using TUI mode instead of `-p` | Always use `-p` for non-interactive invocations |
| Process hangs on input | stdin not set to ignore | When using `exec`/`spawn`, set stdin to `ignore` or `/dev/null` |

### Timeout strategy

For long-running tasks, guard against hangs:

```bash
timeout 600 cursor-agent -p --force --trust "prompt"
```

If the process is killed by timeout, the exit code will be 124. Treat this as "task incomplete, may need to continue with --resume".

### Anti-patterns

- **Do NOT** use `cursor` (TUI) or `opencode` (TUI) — these require a terminal and will hang without user input. Always use `cursor-agent -p` and `opencode run`.
- **Do NOT** run cursor-agent in background and poll for results. Use synchronous execution (wait for process exit).
- **Do NOT** pipe interactive input to cursor-agent. Set stdin to `ignore`. The `-p` flag makes it non-interactive.
- **Do NOT** use heartbeat/event chains to detect process completion. Process exit is the only signal you need.

## Practical Tips

- **Check workspace changes**: `git diff HEAD` in the workspace directory after each round.
- **Parallel agents**: run multiple cursor-agent instances with different chatIds in separate subAgents.
- **Model selection**: `--model sonnet-4-thinking` for complex tasks, cheaper models for routine work.
- **Worktrees for isolation**: `cursor-agent -p -w feature-branch --worktree-base main "implement feature"` to work in an isolated git worktree without affecting the main working directory.
- **Read-only analysis**: `cursor-agent -p --mode plan --trust --workspace /path "analyze this project"` to get analysis without any file modifications.
