import {
  EXTRACTION_TOOL_INPUT_SCHEMA,
  ExtractionSchema,
  type Extraction,
} from "@test-evals/shared";

import type { LlmClient } from "./client";
import { priceUsage, type UsageBreakdown } from "./pricing";
import { hashStrategy, type PromptStrategy } from "./strategies";

export const TOOL_NAME = "record_extraction";

export interface AttemptTrace {
  attempt: number;
  request: {
    model: string;
    systemBlocks: { text: string; cached: boolean }[];
    messages: unknown;
    toolChoice: unknown;
  };
  response: unknown;
  toolInput: unknown | null;
  validationErrors: string[] | null;
  usage: UsageBreakdown;
  costUsd: number;
  durationMs: number;
}

export interface ExtractResult {
  /** Final validated extraction, or null if all attempts failed. */
  extraction: Extraction | null;
  attempts: AttemptTrace[];
  schemaInvalid: boolean;
  totalUsage: UsageBreakdown;
  totalCostUsd: number;
  totalDurationMs: number;
  promptHash: string;
}

export interface ExtractParams {
  client: LlmClient;
  strategy: PromptStrategy;
  model: string;
  transcript: string;
  /** Cap retries; the spec says 3 total attempts. */
  maxAttempts?: number;
  maxTokens?: number;
  temperature?: number;
}

export async function extract(p: ExtractParams): Promise<ExtractResult> {
  const maxAttempts = p.maxAttempts ?? 3;
  const promptHash = hashStrategy(p.strategy);
  const tool = {
    name: TOOL_NAME,
    description:
      "Record the structured clinical extraction for the transcript. Always call this exactly once.",
    input_schema: EXTRACTION_TOOL_INPUT_SCHEMA,
  };

  const attempts: AttemptTrace[] = [];
  const totalUsage: UsageBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let totalDurationMs = 0;

  // Conversation accumulates across retry rounds so the model sees its
  // prior (invalid) tool call and the validator's complaint.
  const messages: {
    role: "user" | "assistant";
    content: unknown;
  }[] = [
    {
      role: "user",
      content: p.strategy.userPrefix + p.transcript,
    },
  ];

  let extraction: Extraction | null = null;
  let schemaInvalid = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    const res = await p.client.call({
      model: p.model,
      system: p.strategy.systemBlocks,
      messages: messages as never,
      tools: [tool] as never,
      toolChoice: { type: "tool", name: TOOL_NAME } as never,
      maxTokens: p.maxTokens ?? 1500,
      temperature: p.temperature ?? 0,
    });
    const dur = Date.now() - start;
    totalDurationMs += dur;
    totalUsage.inputTokens += res.usage.inputTokens;
    totalUsage.outputTokens += res.usage.outputTokens;
    totalUsage.cacheReadInputTokens += res.usage.cacheReadInputTokens;
    totalUsage.cacheCreationInputTokens += res.usage.cacheCreationInputTokens;

    const parsed = ExtractionSchema.safeParse(res.toolInput);

    const trace: AttemptTrace = {
      attempt,
      request: {
        model: p.model,
        systemBlocks: p.strategy.systemBlocks.map((b) => ({
          text: b.text,
          cached: b.cache_control?.type === "ephemeral",
        })),
        messages,
        toolChoice: { type: "tool", name: TOOL_NAME },
      },
      response: res.response,
      toolInput: res.toolInput,
      validationErrors: null,
      usage: res.usage,
      costUsd: priceUsage(p.model, res.usage),
      durationMs: dur,
    };

    if (parsed.success) {
      extraction = parsed.data;
      attempts.push(trace);
      break;
    }

    const errors = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    trace.validationErrors = errors;
    attempts.push(trace);

    if (attempt === maxAttempts) {
      schemaInvalid = true;
      break;
    }

    // Feed the (invalid) assistant turn back, then ask for correction.
    // We use the SDK's tool_result message convention so the model sees
    // the validation failure as a tool result and can correct itself.
    const assistantContent = (res.response as { content: unknown }).content;
    const toolUseId =
      Array.isArray(assistantContent) &&
      (assistantContent as { type: string; id?: string }[]).find((b) => b.type === "tool_use")
        ?.id;

    messages.push({ role: "assistant", content: assistantContent });
    if (toolUseId) {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            is_error: true,
            content: `The previous tool call failed JSON Schema validation. Fix every issue and call \`${TOOL_NAME}\` again. Do not omit or invent fields.\n\nValidation errors:\n${errors.map((e) => `- ${e}`).join("\n")}`,
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: `Your last response did not call the \`${TOOL_NAME}\` tool. Call it now with valid arguments.`,
      });
    }
  }

  return {
    extraction,
    attempts,
    schemaInvalid,
    totalUsage,
    totalCostUsd: priceUsage(p.model, totalUsage),
    totalDurationMs,
    promptHash,
  };
}
