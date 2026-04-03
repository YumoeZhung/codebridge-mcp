# CodeBridge MCP

MCP server，让任何 AI agent 同步调用 coding CLI（cursor-agent、opencode）。spawn 进程 → 等待退出 → 返回完整结果，不依赖 heartbeat 或轮询。

## 前提条件

- Node.js >= 20
- 至少安装了以下 CLI 之一：
  - `cursor-agent`（Cursor 的 CLI 模式）
  - `opencode`（OpenCode CLI）

验证 CLI 是否可用：

```bash
cursor-agent --version   # 或你的自定义路径
opencode --version
```

## 安装

```bash
cd /Users/nodeskai/projects/codebridge-mcp
npm install
```

验证安装成功：

```bash
node --check src/server.js && echo "OK"
```

## 接入方式

CodeBridge 是标准 MCP server（stdio transport），任何支持 MCP 的 agent 都能接入。

### OpenClaw

读取 `~/.openclaw/openclaw.json`，在顶层 `mcp.servers` 对象中添加 `codebridge` 条目。如果 `mcp` 或 `mcp.servers` 字段还不存在就创建。不要覆盖已有的其他 server 条目。

需要添加的配置：

```json
{
  "codebridge": {
    "command": "node",
    "args": ["/Users/nodeskai/projects/codebridge-mcp/src/server.js"],
    "env": {
      "CURSOR_AGENT_BIN": "cursor-agent",
      "OPENCODE_BIN": "opencode"
    }
  }
}
```

操作步骤（面向 Agent 的精确指令）：

1. 读取 `~/.openclaw/openclaw.json`
2. 解析 JSON，定位 `mcp.servers` 字段（不存在则创建）
3. 在 `mcp.servers` 下添加上面的 `codebridge` 条目
4. 写回文件（保持其他字段不变）
5. 重启 openclaw 让配置生效（或等待下次 agent run 自动加载）

如果 `CURSOR_AGENT_BIN` 或 `OPENCODE_BIN` 不在 PATH 中，将值改为绝对路径，例如 `/usr/local/bin/cursor-agent`。

### Cursor / Claude Desktop / 其他 MCP 客户端

在对应的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
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
```

### 手动测试

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | node src/server.js
```

看到 `result` 响应说明 server 正常工作。

## 工具列表

安装后 agent 会获得以下三个 MCP 工具：

### `run_code_agent`

单轮同步执行。spawn 一个 coding CLI 进程，阻塞直到退出，返回完整输出 + git diff。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | `"cursor"` \| `"opencode"` | 是 | 使用哪个 CLI |
| `prompt` | string | 是 | 发给 coding agent 的指令 |
| `workspace` | string | 是 | 项目目录绝对路径 |
| `session_id` | string | 否 | 续接已有会话 |
| `model` | string | 否 | 覆盖默认模型 |
| `timeout_seconds` | number | 否 | 超时秒数（默认 600） |

返回 JSON，包含 `output`、`session_id`、`exit_code`、`duration_ms`、`diff`。

### `run_code_loop`

自主多轮循环。发送高层目标，自动多轮调用 CLI 直到 agent 输出 `TASK_COMPLETE` 或达到 `max_turns`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | `"cursor"` \| `"opencode"` | 是 | 使用哪个 CLI |
| `goal` | string | 是 | 高层目标描述 |
| `workspace` | string | 是 | 项目目录绝对路径 |
| `max_turns` | number | 否 | 最大轮次（默认 10） |
| `session_id` | string | 否 | 从已有会话继续 |
| `timeout_seconds_per_turn` | number | 否 | 每轮超时秒数（默认 600） |

注意：整个 loop 是一次 tool call，调用者全程阻塞。

### `workspace_diff`

获取工作区当前 git 变更。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workspace` | string | 是 | 项目目录绝对路径 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CURSOR_AGENT_BIN` | `cursor-agent` | cursor-agent 可执行文件路径 |
| `OPENCODE_BIN` | `opencode` | opencode 可执行文件路径 |
| `CURSOR_MODEL` | (空) | cursor 默认模型 |
| `OPENCODE_MODEL` | (空) | opencode 默认模型 |
| `SESSION_STORE_PATH` | `./data/sessions.json` | session 持久化文件路径 |

## 原理

cursor-agent 和 opencode 都提供非交互 CLI 模式：

- `cursor-agent -p --output-format text --force --resume <chatId> <prompt>`
- `opencode run --format json --dir <workspace> --session <id> <prompt>`

CodeBridge 用 `child_process.spawn` 启动这些 CLI，stdin 设为 `ignore`（不会因等待输入而挂起），通过管道收集 stdout/stderr，等待进程退出拿到 exit code。整个过程是确定性的：进程退出 = 结果可用。
