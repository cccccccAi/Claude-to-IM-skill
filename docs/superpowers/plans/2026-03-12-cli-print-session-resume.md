# CLI Print Session Resume 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CLI Print 模式支持跨消息会话恢复，使 IM 聊天具备上下文记忆能力。

**Architecture:** 将 `claude --print` 改为 `claude --print --output-format stream-json --include-partial-messages` 获取结构化 NDJSON 输出（含 `session_id`），有 `sdkSessionId` 时追加 `--resume <id>` 恢复会话。用纯函数 `parseLine()` 解析每行 JSON，provider 将解析结果转为 SSE 事件传递给上层 conversation engine 存储。`assistant` 全文消息一律跳过（因为 `--include-partial-messages` 已经通过 `content_block_delta` 流式输出了文本）。

**Tech Stack:** Node.js child_process spawn, NDJSON stream parsing, Claude CLI `--output-format stream-json`

---

## 背景

### 当前问题

CLI Print 模式（`claude --print <prompt>`）完全无状态，每条消息都是全新对话。用户在 IM 中连续对话时 Claude 不知道之前聊了什么。

### 已有基础设施

上游 conversation engine 已经完整实现了 session ID 的存储和传递：

1. `ChannelBinding.sdkSessionId` — 缓存上次对话的 session ID
2. `StreamChatParams.sdkSessionId` — 传递给 LLM provider
3. conversation engine 从 `status` 和 `result` SSE 事件中提取 `session_id` 并持久化
4. `computeSdkSessionUpdate()` — 错误时清空 session ID（`hasError → sdkSessionId = ""`），成功时保存新 ID

SDK Provider 已经用 `resume: params.sdkSessionId` 实现了会话恢复。CLI Print Provider 只需补齐同样的能力。

### stream-json 输出格式

`claude --print --output-format stream-json --include-partial-messages` 输出 NDJSON（每行一个 JSON），消息类型包括：

- `{"type": "system", "subtype": "init", "session_id": "...", "model": "..."}` — 初始化，**含 session_id**
- `{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}` — 文本增量（流式）
- `{"type": "assistant", "message": {"content": [...]}}` — 完整消息（与 delta 重复，**必须跳过**）
- `{"type": "result", "subtype": "success", "session_id": "...", "is_error": false, "usage": {...}}` — 结果，**含 session_id**
- 其他类型（`auth_status` 等）— 跳过

### 关键 CLI 标志

- `--output-format stream-json` — 结构化 NDJSON 输出
- `--include-partial-messages` — 输出增量文本 delta（实现流式）
- `--resume <session_id>` — 恢复指定会话

## 文件结构

| 操作 | 文件                                       | 职责                                     |
| ---- | ------------------------------------------ | ---------------------------------------- |
| 创建 | `src/cli-print-parser.ts`                  | NDJSON 行解析器，纯函数，易测试          |
| 修改 | `src/cli-print-provider.ts`                | 核心改造：stream-json 解析 + resume 支持 |
| 创建 | `src/__tests__/cli-print-parser.test.ts`   | parser 单元测试                          |
| 创建 | `src/__tests__/cli-print-provider.test.ts` | provider 参数构建测试                    |

---

## Chunk 1: NDJSON 行解析器

### Task 1: cli-print-parser — 纯函数解析 NDJSON 行

**Files:**

- Create: `src/cli-print-parser.ts`
- Create: `src/__tests__/cli-print-parser.test.ts`

#### 设计

解析器接收一行 JSON 字符串，返回结构化的动作指令。`assistant` 类型一律返回 `skip`（因为文本已通过 `content_block_delta` 流式输出，`assistant` 全文会造成重复）。

```typescript
// src/cli-print-parser.ts
export type ParsedAction =
  | { kind: "text"; text: string }
  | { kind: "status"; sessionId: string; model?: string }
  | { kind: "result"; sessionId: string; isError: boolean; usage: ResultUsage }
  | { kind: "error"; message: string }
  | { kind: "skip" };

export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

export function parseLine(line: string): ParsedAction;
```

- [ ] **Step 1: 写失败测试 — 基础消息类型解析**

```typescript
// src/__tests__/cli-print-parser.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../cli-print-parser.js";

describe("parseLine", () => {
  it("parses system init message", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-sonnet-4-6",
    });
    assert.deepStrictEqual(parseLine(line), {
      kind: "status",
      sessionId: "abc-123",
      model: "claude-sonnet-4-6",
    });
  });

  it("parses content_block_delta text", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    });
    assert.deepStrictEqual(parseLine(line), { kind: "text", text: "Hello" });
  });

  it("skips content_block_delta with non-text delta type", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{}" },
    });
    assert.deepStrictEqual(parseLine(line), { kind: "skip" });
  });

  it("parses result success", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      is_error: false,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.001,
    });
    assert.deepStrictEqual(parseLine(line), {
      kind: "result",
      sessionId: "abc-123",
      isError: false,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
        cost_usd: 0.001,
      },
    });
  });

  it("parses result success with is_error true", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      is_error: true,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    const result = parseLine(line);
    assert.equal(result.kind, "result");
    if (result.kind === "result") {
      assert.equal(result.isError, true);
    }
  });

  it("parses result error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      errors: ["Something went wrong"],
    });
    assert.deepStrictEqual(parseLine(line), {
      kind: "error",
      message: "Something went wrong",
    });
  });

  it("skips assistant messages (text already streamed via delta)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Full response" }],
      },
    });
    assert.deepStrictEqual(parseLine(line), { kind: "skip" });
  });

  it("returns skip for unknown types", () => {
    assert.deepStrictEqual(parseLine(JSON.stringify({ type: "auth_status" })), {
      kind: "skip",
    });
  });

  it("returns skip for invalid JSON", () => {
    assert.deepStrictEqual(parseLine("not json"), { kind: "skip" });
  });

  it("returns skip for empty line", () => {
    assert.deepStrictEqual(parseLine(""), { kind: "skip" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import tsx src/__tests__/cli-print-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 parseLine**

```typescript
// src/cli-print-parser.ts

export type ParsedAction =
  | { kind: "text"; text: string }
  | { kind: "status"; sessionId: string; model?: string }
  | { kind: "result"; sessionId: string; isError: boolean; usage: ResultUsage }
  | { kind: "error"; message: string }
  | { kind: "skip" };

export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

export function parseLine(line: string): ParsedAction {
  if (!line.trim()) return { kind: "skip" };

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "skip" };
  }

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) {
        return {
          kind: "status",
          sessionId: msg.session_id as string,
          model: (msg.model as string) || undefined,
        };
      }
      return { kind: "skip" };
    }

    case "content_block_delta": {
      const delta = msg.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { kind: "text", text: delta.text };
      }
      return { kind: "skip" };
    }

    // assistant messages carry the full response text, which duplicates
    // the content_block_delta stream. Always skip to avoid double output.
    case "assistant":
      return { kind: "skip" };

    case "result": {
      if (msg.subtype === "success") {
        const usage = msg.usage as Record<string, number> | undefined;
        return {
          kind: "result",
          sessionId: (msg.session_id as string) || "",
          isError: !!msg.is_error,
          usage: {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
            cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens:
              usage?.cache_creation_input_tokens ?? 0,
            cost_usd: (msg.total_cost_usd as number) ?? 0,
          },
        };
      }
      // Error result
      const errors = msg.errors as string[] | undefined;
      return {
        kind: "error",
        message: Array.isArray(errors) ? errors.join("; ") : "Unknown error",
      };
    }

    default:
      return { kind: "skip" };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test --import tsx src/__tests__/cli-print-parser.test.ts`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli-print-parser.ts src/__tests__/cli-print-parser.test.ts
git commit -m "feat: add NDJSON line parser for cli-print stream-json output"
```

---

## Chunk 2: 改造 CLIPrintProvider

### Task 2: 改造 streamChat 使用 stream-json + resume

**Files:**

- Modify: `src/cli-print-provider.ts` (全文重写)
- Create: `src/__tests__/cli-print-provider.test.ts`

#### 核心改动

1. CLI 参数：`--print --output-format stream-json --include-partial-messages`
2. 有 `sdkSessionId` 时追加 `--resume <id>`
3. 逐行解析 NDJSON 输出，用 `parseLine()` 转换为 SSE 事件
4. 从 `status`/`result` 事件中提取 `session_id` 传递给上层

- [ ] **Step 6: 写 provider 测试 — 参数构建**

```typescript
// src/__tests__/cli-print-provider.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCliArgs } from "../cli-print-provider.js";

describe("buildCliArgs", () => {
  it("builds basic args without session", () => {
    const args = buildCliArgs({ prompt: "hello" });
    assert.deepStrictEqual(args, [
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "hello",
    ]);
  });

  it("adds --resume when sdkSessionId provided", () => {
    const args = buildCliArgs({ prompt: "hello", sdkSessionId: "sess-abc" });
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("sess-abc"));
    // --resume should come before the prompt (positional arg)
    const resumeIdx = args.indexOf("--resume");
    const promptIdx = args.indexOf("hello");
    assert.ok(resumeIdx < promptIdx);
  });

  it("adds --model when model provided", () => {
    const args = buildCliArgs({ prompt: "hello", model: "claude-sonnet-4-6" });
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("claude-sonnet-4-6"));
  });

  it("does not add --resume when sdkSessionId is empty", () => {
    const args = buildCliArgs({ prompt: "hello", sdkSessionId: "" });
    assert.ok(!args.includes("--resume"));
  });

  it("does not add --resume when sdkSessionId is undefined", () => {
    const args = buildCliArgs({ prompt: "hello", sdkSessionId: undefined });
    assert.ok(!args.includes("--resume"));
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `node --test --import tsx src/__tests__/cli-print-provider.test.ts`
Expected: FAIL — buildCliArgs not exported

- [ ] **Step 8: 重写 cli-print-provider.ts**

```typescript
/**
 * LLM Provider using `claude --print` CLI mode with stream-json output.
 *
 * Unlike SDKLLMProvider (which uses claude-agent-sdk and requires API key),
 * this provider spawns claude with the `--print` flag which uses the
 * standard CLI entrypoint (cc_entrypoint=cli) — compatible with Claude
 * Code subscription accounts (OAuth login).
 *
 * Session resume: Uses --output-format stream-json to capture session_id
 * from CLI output, and --resume <id> to restore conversation context.
 *
 * Limitations vs SDK mode:
 * - No tool use / file editing support
 * - No inline permission prompts
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  LLMProvider,
  StreamChatParams,
} from "claude-to-im/src/lib/bridge/host.js";
import { buildSubprocessEnv, resolveClaudeCliPath } from "./llm-provider.js";
import { sseEvent } from "./sse-utils.js";
import { parseLine } from "./cli-print-parser.js";

/** Build CLI arguments for `claude --print` with stream-json output. */
export function buildCliArgs(params: {
  prompt: string;
  sdkSessionId?: string;
  model?: string;
}): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
  if (params.sdkSessionId) {
    args.push("--resume", params.sdkSessionId);
  }
  if (params.model) {
    args.push("--model", params.model);
  }
  args.push(params.prompt);
  return args;
}

export class CLIPrintProvider implements LLMProvider {
  private cliPath: string;

  constructor(cliPath?: string) {
    this.cliPath = cliPath ?? resolveClaudeCliPath() ?? "claude";
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const cliPath = this.cliPath;
    const env = buildSubprocessEnv();

    return new ReadableStream({
      start(controller) {
        (async () => {
          try {
            const args = buildCliArgs({
              prompt: params.prompt,
              sdkSessionId: params.sdkSessionId,
              model: params.model,
            });

            const resumeInfo = params.sdkSessionId
              ? ` --resume ${params.sdkSessionId}`
              : "";
            console.log(
              `[cli-print-provider] Spawning: ${cliPath} --print --output-format stream-json${resumeInfo}`,
            );

            const proc = spawn(cliPath, args, {
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });

            proc.stdin.end();

            const MAX_STDERR = 4096;
            let stderrBuf = "";
            let hasResult = false;
            // Buffer for incomplete NDJSON lines
            let lineBuf = "";
            const decoder = new StringDecoder("utf-8");

            proc.stderr?.on("data", (chunk: Buffer) => {
              stderrBuf += chunk.toString();
              if (stderrBuf.length > MAX_STDERR) {
                stderrBuf = stderrBuf.slice(-MAX_STDERR);
              }
            });

            proc.stdout?.on("data", (chunk: Buffer) => {
              lineBuf += decoder.write(chunk);

              // Process complete lines
              let newlineIdx: number;
              while ((newlineIdx = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, newlineIdx).trim();
                lineBuf = lineBuf.slice(newlineIdx + 1);

                if (!line) continue;

                const action = parseLine(line);
                switch (action.kind) {
                  case "text":
                    controller.enqueue(sseEvent("text", action.text));
                    break;
                  case "status":
                    controller.enqueue(
                      sseEvent("status", {
                        session_id: action.sessionId,
                        model: action.model,
                      }),
                    );
                    break;
                  case "result":
                    hasResult = true;
                    controller.enqueue(
                      sseEvent("result", {
                        session_id: action.sessionId,
                        is_error: action.isError,
                        usage: action.usage,
                      }),
                    );
                    break;
                  case "error":
                    controller.enqueue(sseEvent("error", action.message));
                    break;
                  case "skip":
                    break;
                }
              }
            });

            const code = await new Promise<number>((resolve, reject) => {
              proc.on("exit", (c) => resolve(c ?? 0));
              proc.on("error", reject);
            });

            // Flush remaining buffer
            const remaining = (lineBuf + decoder.end()).trim();
            if (remaining) {
              const action = parseLine(remaining);
              if (action.kind === "text") {
                controller.enqueue(sseEvent("text", action.text));
              } else if (action.kind === "result") {
                hasResult = true;
                controller.enqueue(
                  sseEvent("result", {
                    session_id: action.sessionId,
                    is_error: action.isError,
                    usage: action.usage,
                  }),
                );
              }
            }

            if (code !== 0 && !hasResult) {
              const errMsg =
                stderrBuf.trim() || `claude exited with code ${code}`;
              console.error("[cli-print-provider] Error:", errMsg);
              controller.enqueue(sseEvent("error", errMsg));
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[cli-print-provider] Spawn error:", message);
            controller.enqueue(sseEvent("error", message));
            controller.close();
          }
        })();
      },
    });
  }
}
```

- [ ] **Step 9: 运行所有测试**

Run: `node --test --import tsx src/__tests__/cli-print-parser.test.ts src/__tests__/cli-print-provider.test.ts`
Expected: ALL PASS

- [ ] **Step 10: 提交**

```bash
git add src/cli-print-provider.ts src/__tests__/cli-print-provider.test.ts
git commit -m "feat: cli-print provider supports session resume via --output-format stream-json"
```

---

## Chunk 3: 构建验证

### Task 3: TypeScript 编译 + 全量测试

**Files:** 无新文件

- [ ] **Step 11: TypeScript 构建验证**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 12: 完整测试**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 13: 提交（如有修复）**

如果 Step 11/12 发现问题并修复，提交修复。

---

## Resume 失败的降级策略

`--resume <id>` 可能因 session 过期/不存在而失败。两种可能的 CLI 行为：

1. **CLI 返回 result 事件 + 非零退出码**：上游 `computeSdkSessionUpdate()` 检测到 `hasError = true` 后会清空 `sdkSessionId`（设为 `""`），下一条消息自动回退到全新对话。
2. **CLI 静默创建新会话**：输出全新的 `session_id`，conversation engine 正常保存新 ID，后续消息用新 session 继续。

两种情况都能正确降级，**无需额外处理**。

> **注意**：首次实现后需手动验证一次 `claude --print --output-format stream-json --resume <invalid_id> "test"` 的真实行为，确认上述假设。

## 验证方案

手动验证（需要 IM 通道）：

1. 发送第一条消息 → 检查日志确认 `--output-format stream-json` 参数
2. 检查 store 中 binding 的 `sdkSessionId` 不再为空
3. 发送第二条消息 → 检查日志确认 `--resume <session_id>` 参数
4. 验证 Claude 回复具有上文记忆（例如第一条说"我叫小明"，第二条问"我叫什么"）
5. 重启 daemon → 发送消息 → 确认仍能恢复会话（sdkSessionId 持久化在 store 中）
6. 验证 resume 失败降级：手动篡改 store 中的 `sdkSessionId` 为无效值，发送消息，确认不会死循环
