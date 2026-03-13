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
    "--verbose",
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
