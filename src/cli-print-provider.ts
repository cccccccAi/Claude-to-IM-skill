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
import {
  buildSubprocessEnv,
  resolveClaudeCliPath,
  classifyAuthError,
} from "./llm-provider.js";
import { sseEvent } from "./sse-utils.js";
import { parseLine } from "./cli-print-parser.js";

/** Default request timeout in milliseconds (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Build CLI arguments for `claude --print` with stream-json output. */
export function buildCliArgs(params: {
  prompt: string;
  sdkSessionId?: string;
  model?: string;
  dangerouslySkipPermissions?: boolean;
}): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (params.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
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
  private dangerouslySkipPermissions: boolean;
  private timeoutMs: number;

  constructor(
    cliPath?: string,
    dangerouslySkipPermissions = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.cliPath = cliPath ?? resolveClaudeCliPath() ?? "claude";
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.timeoutMs = timeoutMs;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const cliPath = this.cliPath;
    const dangerouslySkipPermissions = this.dangerouslySkipPermissions;
    const env = buildSubprocessEnv();
    const timeoutMs = this.timeoutMs;
    const workingDirectory = params.workingDirectory;

    return new ReadableStream({
      start(controller) {
        (async () => {
          let timedOut = false;
          let proc: ReturnType<typeof spawn> | undefined;
          // Track whether any text has been streamed to the user.
          // Used by the timeout handler to append a truncation marker (▌)
          // when the response was cut short mid-stream.
          let hasText = false;

          // Timeout: kill the subprocess and close the stream.
          // - No alarming error message is sent — the user can simply send
          //   their next message to continue from the same session.
          // - If partial text was already streamed, append ▌ so the user
          //   knows the response was cut short and can ask to "继续".
          // - Stream is closed WITHOUT an "error" event so hasError stays
          //   false → computeSdkSessionUpdate preserves sdkSessionId →
          //   next message auto-resumes via --resume.
          const timeoutHandle = setTimeout(() => {
            timedOut = true;
            proc?.kill("SIGTERM");
            console.warn(
              `[cli-print-provider] Request timed out after ${timeoutMs / 1000}s — session preserved`,
            );
            if (hasText) {
              // Append truncation marker so user knows to say "继续"
              controller.enqueue(sseEvent("text", " ▌"));
            }
            controller.close();
          }, timeoutMs);

          try {
            const args = buildCliArgs({
              prompt: params.prompt,
              sdkSessionId: params.sdkSessionId,
              model: params.model,
              dangerouslySkipPermissions,
            });

            const resumeInfo = params.sdkSessionId
              ? ` --resume ${params.sdkSessionId}`
              : "";
            console.log(
              `[cli-print-provider] Spawning: ${cliPath} --print --output-format stream-json${resumeInfo}`,
            );

            proc = spawn(cliPath, args, {
              env,
              cwd: workingDirectory,
              stdio: ["pipe", "pipe", "pipe"],
            });

            proc.stdin.end();

            const MAX_STDERR = 4096;
            let stderrBuf = "";
            let hasResult = false;
            let sessionNotified = false;
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
                    hasText = true;
                    controller.enqueue(sseEvent("text", action.text));
                    break;
                  case "status": {
                    // Notify user once when a new session starts (no prior session,
                    // or session changed from what was requested via --resume).
                    if (!sessionNotified) {
                      sessionNotified = true;
                      const isNew = !params.sdkSessionId;
                      const isSwitched =
                        params.sdkSessionId &&
                        action.sessionId !== params.sdkSessionId;
                      if (isNew || isSwitched) {
                        const short = action.sessionId.slice(0, 8);
                        const label = isSwitched
                          ? "⚠️ 会话已切换"
                          : "🔗 新会话";
                        controller.enqueue(
                          sseEvent("text", `${label}（ID: \`${short}\`）\n\n`),
                        );
                      }
                    }
                    controller.enqueue(
                      sseEvent("status", {
                        session_id: action.sessionId,
                        model: action.model,
                      }),
                    );
                    break;
                  }
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
                    // Send inline CLI errors as "text" (not "error") to preserve
                    // the session — these are API-level errors, not session faults.
                    controller.enqueue(
                      sseEvent("text", `❌ ${action.message}`),
                    );
                    break;
                  case "skip":
                    break;
                }
              }
            });

            const code = await new Promise<number>((resolve, reject) => {
              proc!.on("exit", (c) => resolve(c ?? 0));
              proc!.on("error", reject);
            });

            // Don't process anything further if we already timed out
            if (timedOut) return;
            clearTimeout(timeoutHandle);

            // Flush remaining buffer
            const remaining = (lineBuf + decoder.end()).trim();
            if (remaining) {
              const action = parseLine(remaining);
              if (action.kind === "text") {
                hasText = true;
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
              // Send as "text" (not "error") to preserve sdkSessionId.
              // Auth/network/process errors are all transient — the Claude
              // conversation context is still valid. Clearing the session here
              // would force a brand-new session on the next message, losing all
              // conversation history. Instead, display the error as a message and
              // let the user fix the underlying issue then retry.
              const combined = [stderrBuf.trim(), ""].join("\n");
              const authKind = classifyAuthError(combined);
              let errMsg: string;
              if (authKind === "cli") {
                errMsg =
                  "❌ Claude CLI 未登录，请在终端执行 `claude auth login` 后重发消息。（会话已保留）";
              } else if (authKind === "api") {
                errMsg =
                  "❌ API 凭证错误，请检查 config.env 中的 ANTHROPIC_API_KEY。（会话已保留）";
              } else {
                errMsg = `❌ ${stderrBuf.trim() || `claude exited with code ${code}`}（发下一条消息可继续会话）`;
              }
              console.error(
                "[cli-print-provider] Error (session preserved):",
                errMsg,
              );
              controller.enqueue(sseEvent("text", errMsg));
            }

            controller.close();
          } catch (err) {
            if (timedOut) return;
            clearTimeout(timeoutHandle);
            // Spawn-level errors (e.g. claude binary not found) — also send as
            // "text" to preserve the session for the next retry.
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              "[cli-print-provider] Spawn error (session preserved):",
              message,
            );
            controller.enqueue(
              sseEvent("text", `❌ 启动 Claude 失败：${message}`),
            );
            controller.close();
          }
        })();
      },
    });
  }
}
