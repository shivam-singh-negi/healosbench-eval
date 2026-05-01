import Anthropic from "@anthropic-ai/sdk";

export interface LlmCallParams {
  model: string;
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  toolChoice: Anthropic.ToolChoice;
  maxTokens: number;
  temperature: number;
}

export interface LlmCallResult {
  /** Raw Anthropic response — kept for the trace UI. */
  response: Anthropic.Message;
  /** Decoded tool input the model emitted, or null if no tool_use block. */
  toolInput: unknown | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface LlmClient {
  call(p: LlmCallParams): Promise<LlmCallResult>;
}

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async call(p: LlmCallParams): Promise<LlmCallResult> {
    const response = await this.client.messages.create({
      model: p.model,
      system: p.system,
      messages: p.messages,
      tools: p.tools,
      tool_choice: p.toolChoice,
      max_tokens: p.maxTokens,
      temperature: p.temperature,
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    return {
      response,
      toolInput: toolBlock?.input ?? null,
      usage: {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
