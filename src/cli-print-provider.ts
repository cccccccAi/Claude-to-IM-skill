/**
 * LLM Provider using `claude --print` CLI mode.
 *
 * Unlike SDKLLMProvider (which uses claude-agent-sdk and requires API key),
 * this provider spawns claude with the `--print` flag which uses the
 * standard CLI entrypoint (cc_entrypoint=cli) — compatible with Claude
 * Code subscription accounts (OAuth login).
 *
 * Limitations vs SDK mode:
 * - No cross-message session persistence (each call is fresh)
 * - No tool use / file editing support
 * - No inline permission prompts
 */

import { spawn } from "node:child_process";
import type {
  LLMProvider,
  StreamChatParams,
} from "claude-to-im/src/lib/bridge/host.js";
import { buildSubprocessEnv, resolveClaudeCliPath } from "./llm-provider.js";
import { sseEvent } from "./sse-utils.js";

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
            const args = ["--print", params.prompt];
            if (params.model) args.push("--model", params.model);

            console.log(
              `[cli-print-provider] Spawning: ${cliPath} --print <prompt>`,
            );

            const proc = spawn(cliPath, args, {
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });

            proc.stdin.end();

            let stderrBuf = "";
            proc.stderr?.on("data", (chunk: Buffer) => {
              stderrBuf += chunk.toString();
            });

            // Stream stdout chunks as text SSE events
            proc.stdout?.on("data", (chunk: Buffer) => {
              controller.enqueue(sseEvent("text", chunk.toString()));
            });

            const code = await new Promise<number>((resolve, reject) => {
              proc.on("exit", (c) => resolve(c ?? 0));
              proc.on("error", reject);
            });

            if (code !== 0) {
              const errMsg =
                stderrBuf.trim() || `claude exited with code ${code}`;
              console.error("[cli-print-provider] Error:", errMsg);
              controller.enqueue(sseEvent("error", errMsg));
            } else {
              controller.enqueue(
                sseEvent("result", {
                  session_id: "",
                  is_error: false,
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cost_usd: 0,
                  },
                }),
              );
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
