import { describe, expect, it } from "bun:test";

import { extract } from "../packages/llm/src/extract";
import {
  RateLimitedSemaphore,
  isRateLimitError,
} from "../packages/llm/src/concurrency";
import { hashStrategy } from "../packages/llm/src/strategies";
import { zeroShot } from "../packages/llm/src/strategies/zero_shot";
import type { LlmCallParams, LlmCallResult, LlmClient } from "../packages/llm/src/client";

const validToolInput = {
  chief_complaint: "test",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [],
  plan: ["follow up"],
  follow_up: { interval_days: null, reason: null },
};

function fakeResponse(toolInput: unknown): LlmCallResult {
  const id = "tool_" + Math.random().toString(36).slice(2);
  return {
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "haiku",
      content: [{ type: "tool_use", id, name: "record_extraction", input: toolInput }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never,
    toolInput,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

class FakeClient implements LlmClient {
  calls = 0;
  constructor(private readonly script: ((p: LlmCallParams) => Promise<LlmCallResult>)[]) {}
  async call(p: LlmCallParams): Promise<LlmCallResult> {
    const fn = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls++;
    return fn(p);
  }
}

describe("extractor", () => {
  it("schema-validation retry path: invalid → invalid → valid succeeds in 3 attempts", async () => {
    const client = new FakeClient([
      // attempt 1: missing chief_complaint
      async () =>
        fakeResponse({
          vitals: { bp: null, hr: null, temp_f: null, spo2: null },
          medications: [],
          diagnoses: [],
          plan: [],
          follow_up: { interval_days: null, reason: null },
        }),
      // attempt 2: chief_complaint is empty (still invalid)
      async () => fakeResponse({ ...validToolInput, chief_complaint: "" }),
      // attempt 3: valid
      async () => fakeResponse(validToolInput),
    ]);
    const r = await extract({
      client,
      strategy: zeroShot,
      model: "claude-haiku-4-5-20251001",
      transcript: "x",
    });
    expect(r.extraction).not.toBeNull();
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts[0]!.validationErrors).not.toBeNull();
    expect(r.attempts[1]!.validationErrors).not.toBeNull();
    expect(r.attempts[2]!.validationErrors).toBeNull();
    expect(r.schemaInvalid).toBe(false);
  });

  it("gives up after 3 attempts and flags schemaInvalid", async () => {
    const client = new FakeClient([async () => fakeResponse({ broken: true })]);
    const r = await extract({
      client,
      strategy: zeroShot,
      model: "claude-haiku-4-5-20251001",
      transcript: "x",
    });
    expect(r.extraction).toBeNull();
    expect(r.attempts).toHaveLength(3);
    expect(r.schemaInvalid).toBe(true);
  });

  it("attaches cache_read tokens to the totals", async () => {
    const client = new FakeClient([
      async () => ({
        response: { content: [{ type: "tool_use", id: "x", name: "t", input: validToolInput }] } as never,
        toolInput: validToolInput,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 999, cacheCreationInputTokens: 0 },
      }),
    ]);
    const r = await extract({
      client,
      strategy: zeroShot,
      model: "claude-haiku-4-5-20251001",
      transcript: "x",
    });
    expect(r.totalUsage.cacheReadInputTokens).toBe(999);
  });
});

describe("prompt-hash stability", () => {
  it("produces the same hash for the same strategy", () => {
    expect(hashStrategy(zeroShot)).toBe(hashStrategy(zeroShot));
  });

  it("produces a different hash for a tweaked strategy", () => {
    const tweaked = {
      ...zeroShot,
      systemBlocks: [{ ...zeroShot.systemBlocks[0]!, text: zeroShot.systemBlocks[0]!.text + "." }],
    };
    expect(hashStrategy(tweaked)).not.toBe(hashStrategy(zeroShot));
  });
});

describe("rate-limit backoff", () => {
  it("sleeps and retries on a 429", async () => {
    const sleeps: number[] = [];
    const sem = new RateLimitedSemaphore({
      concurrency: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });
    let calls = 0;
    const out = await sem.run(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("isRateLimitError detects status fields", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});
