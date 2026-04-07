---
name: codebridge-mcp
description: MCP server that lets any agent synchronously invoke coding CLIs (cursor-agent, opencode). Provides check_auth, run_code_agent (single turn) and run_code_loop (autonomous multi-turn) tools.
---

# CodeBridge MCP

通过 MCP 协议同步调用 coding CLI（cursor-agent、opencode）。进程退出即返回结果，无需 heartbeat 或轮询。

## 安装

```bash
cd ~/projects/codebridge-mcp
npm install
```

详细的安装和接入指南见 [README.md](README.md)。

## 认证（首次使用前必读）

cursor-agent 需要认证才能使用。**不需要浏览器登录**，通过 API Key 即可。

### 认证流程（Agent 必须遵循）

1. **首次调用任何工具前**，先调用 `check_auth({ provider: "cursor" })`
2. 如果返回 `authenticated: false`：
   - 检查 MCP 配置中是否设置了 `CURSOR_API_KEY` 环境变量
   - 如果没有，**向用户索要** Cursor API Key
   - 用户可以从 Cursor Settings > API Keys 获取，或运行 `cursor-agent login` 后查看
   - 拿到 key 后，将其写入 MCP 配置的 `env.CURSOR_API_KEY` 字段
   - 提示用户重启 agent 以加载新配置
3. 如果返回 `authenticated: true`，可以正常调用 `run_code_agent` / `run_code_loop`

### 配置示例（带 API Key）

OpenClaw (`~/.openclaw/openclaw.json` → `mcp.servers`):

```json
{
  "codebridge": {
    "command": "node",
    "args": ["/path/to/codebridge-mcp/src/server.js"],
    "env": {
      "CURSOR_API_KEY": "key_xxxxxxxxxxxxxxxx",
      "CURSOR_AGENT_BIN": "cursor-agent",
      "OPENCODE_BIN": "opencode"
    }
  }
}
```

DeskClaw (`~/.deskclaw/nanobot/config.json` → `tools.mcp_servers`):

```json
{
  "codebridge": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/codebridge-mcp/src/server.js"],
    "env": {
      "CURSOR_API_KEY": "key_xxxxxxxxxxxxxxxx",
      "CURSOR_AGENT_BIN": "cursor-agent",
      "OPENCODE_BIN": "opencode"
    },
    "tool_timeout": 660,
    "enabled_tools": ["*"]
  }
}
```

## 可用工具

### `check_auth` — 认证检查

在调用 run_code_agent / run_code_loop 之前**必须**先调用此工具。

```
check_auth({ provider: "cursor" })
```

返回 `{ authenticated: true, models: "..." }` 或 `{ authenticated: false, error: "..." }`。
error 中会包含修复指引，Agent 应按指引操作。

### `run_code_agent` — 单轮同步执行

跑一轮 coding agent，阻塞直到 CLI 进程退出。

```
run_code_agent({
  provider: "cursor",           // "cursor" 或 "opencode"
  prompt: "fix the bug in auth.py",
  workspace: "/path/to/project",
  session_id: "abc123",         // 可选，续接已有会话
  model: "claude-sonnet",       // 可选，覆盖默认模型
  timeout_seconds: 600          // 可选，默认 600
})
```

返回:

```json
{
  "output": "agent 的完整文本输出",
  "session_id": "用于下次续接的 ID",
  "exit_code": 0,
  "duration_ms": 12345,
  "diff": {
    "summary": "本轮代码改动摘要",
    "changed_files": ["src/auth.py"],
    "branch": "main",
    "head_before": "abc1234",
    "head_after": "def5678"
  }
}
```

### `run_code_loop` — 自主多轮循环

发送高层目标，自动多轮执行直到 agent 报告 TASK_COMPLETE 或达到最大轮次。

```
run_code_loop({
  provider: "opencode",
  goal: "实现用户注册功能，包括表单验证和数据库迁移",
  workspace: "/path/to/project",
  max_turns: 10,                // 可选，默认 10
  timeout_seconds_per_turn: 600 // 可选，每轮超时
})
```

注意: 整个 loop 是一次 tool call，调用者的 LLM turn 全程阻塞。

### `workspace_diff` — 工作区变更

```
workspace_diff({ workspace: "/path/to/project" })
```

## 使用模式

### 模式 1: 手动循环（推荐用于复杂任务）

Agent 自己控制每一步，可以在轮次之间分析结果、发通知、调整策略:

1. 调用 `run_code_agent(prompt: "创建实施计划")` → 拿到 plan
2. 分析 plan，拆解步骤
3. 调用 `run_code_agent(prompt: "实施第一步: ...")` → 拿到结果
4. 发飞书通知：第一步完成
5. 调用 `run_code_agent(prompt: "实施第二步: ...")` → 继续
6. 重复直到完成

### 模式 2: 自动循环（适合简单批量任务）

一次 tool call 完成所有轮次:

```
run_code_loop(goal: "重构 auth 模块，拆分为独立服务", max_turns: 5)
```

### 模式 3: 混合（推荐用于大型项目）

1. 用 `run_code_agent` 做 plan
2. 分析 plan 拆解为独立子任务
3. 每个子任务用 `run_code_loop` 执行

## 平台特定用法

### OpenClaw（有 subAgent）

将编码循环放入 subAgent，主 agent 保持响应:

1. 主 agent: `sessions_spawn(task: "用 cursor 完成产品 A", timeout: 3600)`
2. subAgent: 多次调用 `run_code_agent`，每轮之间发飞书通知
3. subAgent 完成 → announce 推送结果到主 agent
4. 主 agent 通知人类

关键: subAgent 的 `runTimeoutSeconds` 必须 >= 编码循环总时长（建议 3600+）。

### DeskClaw / nanobot（单 agent）

nanobot 没有 subAgent 机制，调用 `run_code_agent` 或 `run_code_loop` 时 agent 会被阻塞。

适合的场景：
- 用户明确下达编码任务后不需要交互（如"晚上睡觉前让你做完"）
- 使用 `run_code_loop` 一次性完成，减少 LLM 轮次

推荐工作流：

1. 用户下达目标
2. Agent 调用 `run_code_loop(goal: "...", max_turns: 8)` — agent 全程阻塞
3. loop 结束后 agent 恢复，向用户报告结果

如果任务复杂需要中途调整，用模式 1（手动循环），每轮之间 agent 可以分析结果并决定下一步，但每轮期间仍然阻塞。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CURSOR_API_KEY` | (空) | **cursor 必填**。API Key，无需浏览器登录 |
| `CURSOR_AGENT_BIN` | `cursor-agent` | cursor-agent 可执行文件路径 |
| `OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `CURSOR_MODEL` | (空) | cursor 默认模型 |
| `OPENCODE_MODEL` | (空) | opencode 默认模型 |
| `SESSION_STORE_PATH` | `./data/sessions.json` | session 持久化文件路径 |
