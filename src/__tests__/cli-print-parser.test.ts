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

  it("parses stream_event wrapping content_block_delta (--verbose format)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    assert.deepStrictEqual(parseLine(line), { kind: "text", text: "Hello" });
  });

  it("skips stream_event with non-text inner event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "message_start", message: {} },
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
