# CodeBridge

A skill that teaches AI agents how to drive coding CLIs (cursor-agent, opencode) via direct shell invocations. No server process, no dependencies — just a structured document that any agent with shell access can read and follow.

## What this is

`SKILL.md` is the entire deliverable. It contains:

- Authentication setup for cursor-agent and opencode
- CLI command reference with exact flags for non-interactive mode
- Usage patterns for different agent architectures (SubAgent loops, direct execution, human-guided)
- Session management (create, resume, continue)
- Error handling, timeouts, and anti-patterns

## Prerequisites

- **cursor-agent** installed and accessible in PATH (or known absolute path)
  - Requires a `CURSOR_API_KEY` — obtain from Cursor Settings > API Keys
- **opencode** installed and accessible in PATH (optional, for opencode support)

## Installation

Copy or symlink `SKILL.md` into the agent's skill discovery path.

### Cursor

```bash
mkdir -p /path/to/project/.cursor/skills/codebridge
cp SKILL.md /path/to/project/.cursor/skills/codebridge/SKILL.md
```

Or for global availability:

```bash
mkdir -p ~/.cursor/skills/codebridge
cp SKILL.md ~/.cursor/skills/codebridge/SKILL.md
```

### OpenClaw

Place in a location the agent can access (e.g. workspace skills directory), or reference the file path directly when giving the agent instructions.

### DeskClaw (nanobot)

Same as OpenClaw — nanobot uses the OpenClaw skill infrastructure.

## How it works

The skill teaches agents to call cursor-agent and opencode in **non-interactive mode**:

```
cursor-agent -p --force --trust --workspace /project "fix the bug in auth.py"
```

The process runs, exits when done, and the agent reads stdout. No MCP server, no heartbeat, no polling — just `spawn → wait → read output`.

For agents that need to stay responsive (OpenClaw, DeskClaw), the skill recommends spawning a SubAgent that runs the coding loop synchronously while the main agent handles user messages.
