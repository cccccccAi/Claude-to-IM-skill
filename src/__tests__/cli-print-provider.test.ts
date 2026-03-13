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
      "--verbose",
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
