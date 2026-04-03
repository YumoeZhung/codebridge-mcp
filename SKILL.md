---
name: codebridge-mcp
description: MCP server that lets any agent synchronously invoke coding CLIs (cursor-agent, opencode). Provides run_code_agent (single turn) and run_code_loop (autonomous multi-turn) tools.
---

# CodeBridge MCP

通过 MCP 协议同步调用 coding CLI（cursor-agent、opencode）。进程退出即返回结果，无需 heartbeat 或轮询。

## 安装

```bash
cd ~/projects/codebridge-mcp
npm install
```

## 接入 OpenClaw

在 `~/.openclaw/openclaw.json` 的 `mcp.servers` 下添加:

```json
{
  "mcp": {
    "servers": {
      "codebridge": {
        "command": "node",
        "args": ["/Users/nodeskai/projects/codebridge-mcp/src/server.js"],
        "env": {
          "CURSOR_AGENT_BIN": "cursor-agent",
          "OPENCODE_BIN": "opencode"
        }
      }
    }
  }
}
```

## 可用工具

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

## 与 OpenClaw SubAgent 配合

将编码循环放入 subAgent，主 agent 保持响应:

1. 主 agent: `sessions_spawn(task: "用 cursor 完成产品 A", timeout: 3600)`
2. subAgent: 多次调用 `run_code_agent`，每轮之间发飞书通知
3. subAgent 完成 → announce 推送结果到主 agent
4. 主 agent 通知人类

关键: subAgent 的 `runTimeoutSeconds` 必须 >= 编码循环总时长（建议 3600+）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CURSOR_AGENT_BIN` | `cursor-agent` | cursor-agent 可执行文件路径 |
| `OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `CURSOR_MODEL` | (空) | cursor 默认模型 |
| `OPENCODE_MODEL` | (空) | opencode 默认模型 |
| `SESSION_STORE_PATH` | `./data/sessions.json` | session 持久化文件路径 |
