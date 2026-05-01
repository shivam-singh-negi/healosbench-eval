import type { LlmCallParams, LlmCallResult, LlmClient } from "./client";
import { jsonSchemaToGeminiSchema } from "./google-schema";

/**
 * Gemini implementation of LlmClient.
 *
 * Translates the Anthropic-shaped LlmCallParams into Gemini's REST request,
 * then translates the response back into our generic LlmCallResult.
 *
 * What's the same as Anthropic:
 *   - System prompt, user transcript, tool/function declarations.
 *   - Forced tool call, retry-on-validation-error loop (lives in extract.ts).
 *
 * What's different:
 *   - Gemini's caching is implicit and not surfaced as `cache_read_input_tokens`.
 *     We report 0 there. NOTES.md documents the tradeoff.
 *   - Gemini's JSON Schema subset doesn't accept `pattern` or
 *     `additionalProperties`; the schema translator handles this.
 */
export class GoogleClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async call(p: LlmCallParams): Promise<LlmCallResult> {
    const systemText = p.system.map((b) => b.text).join("\n\n");
    const tool = p.tools[0];
    if (!tool) throw new Error("GoogleClient requires at least one tool");

    const functionDeclaration = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: jsonSchemaToGeminiSchema(tool.input_schema),
    };

    const contents = translateMessages(p.messages, tool.name);

    const allowedNames =
      p.toolChoice && typeof p.toolChoice === "object" && "name" in p.toolChoice
        ? [(p.toolChoice as { name: string }).name]
        : [tool.name];

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      tools: [{ functionDeclarations: [functionDeclaration] }],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: allowedNames,
        },
      },
      generationConfig: {
        temperature: p.temperature,
        maxOutputTokens: p.maxTokens,
      },
    };

    const url = `${this.baseUrl}/models/${encodeURIComponent(p.model)}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err: Error & { status?: number } = new Error(`gemini ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as GeminiResponse;

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const fc = parts.find((p): p is GeminiFunctionCallPart => "functionCall" in p);
    const toolInput = fc?.functionCall?.args ?? null;

    const usage = data.usageMetadata;
    return {
      // Wrap into an Anthropic-shaped envelope so the trace UI / DB shape
      // doesn't have to fork. The `content` array contains a synthetic
      // tool_use block plus any text the model emitted (CoT scratchpad).
      response: {
        id: `gemini_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model: p.model,
        provider: "gemini",
        content: [
          ...parts
            .filter((p): p is GeminiTextPart => "text" in p)
            .map((p) => ({ type: "text", text: p.text })),
          ...(fc
            ? [
                {
                  type: "tool_use",
                  id: `gemini_tu_${Math.random().toString(36).slice(2)}`,
                  name: fc.functionCall.name,
                  input: fc.functionCall.args,
                },
              ]
            : []),
        ],
        stop_reason: candidate?.finishReason ?? null,
        usage: {
          input_tokens: usage?.promptTokenCount ?? 0,
          output_tokens: usage?.candidatesTokenCount ?? 0,
        },
        raw: data,
      } as never,
      toolInput,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        cacheReadInputTokens: usage?.cachedContentTokenCount ?? 0,
        cacheCreationInputTokens: 0,
      },
    };
  }
}

interface GeminiTextPart {
  text: string;
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: unknown };
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: unknown };
}
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/**
 * Translate the Anthropic-shaped messages array (used by the retry loop)
 * into Gemini's contents array.
 *
 * Anthropic shapes we must handle:
 *   - { role: "user", content: "...string..." }  → user text
 *   - { role: "user", content: [{ type: "tool_result", tool_use_id, is_error, content: "..." }] }
 *       → user functionResponse
 *   - { role: "assistant", content: [...Anthropic.ContentBlock[]] }
 *       → model: text parts + functionCall part (if a tool_use is present)
 */
function translateMessages(
  messages: { role: "user" | "assistant"; content: unknown }[],
  toolName: string,
): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", parts: [{ text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts: GeminiPart[] = [];
        for (const block of m.content as { type: string; [k: string]: unknown }[]) {
          if (block.type === "tool_result") {
            const errText = String(block.content ?? "");
            parts.push({
              functionResponse: {
                name: toolName,
                response: { error: errText },
              },
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            parts.push({ text: block.text });
          }
        }
        if (parts.length > 0) out.push({ role: "user", parts });
      }
    } else {
      // assistant → model
      if (Array.isArray(m.content)) {
        const parts: GeminiPart[] = [];
        for (const block of m.content as { type: string; [k: string]: unknown }[]) {
          if (block.type === "text" && typeof block.text === "string") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: String(block.name),
                args: block.input as unknown,
              },
            });
          }
        }
        if (parts.length > 0) out.push({ role: "model", parts });
      } else if (typeof m.content === "string") {
        out.push({ role: "model", parts: [{ text: m.content }] });
      }
    }
  }
  return out;
}
