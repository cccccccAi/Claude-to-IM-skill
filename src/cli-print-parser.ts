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

    // --verbose wraps all streaming events in a stream_event envelope
    case "stream_event": {
      const event = msg.event as Record<string, unknown> | undefined;
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return { kind: "text", text: delta.text };
        }
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
