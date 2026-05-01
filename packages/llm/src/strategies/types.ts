import type { Strategy } from "@test-evals/shared";

export interface PromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface PromptStrategy {
  name: Strategy;
  /** System prompt blocks. The last cacheable block carries cache_control. */
  systemBlocks: PromptBlock[];
  /** Tool-choice hint baked into the user message wrapper. */
  userPrefix: string;
  /**
   * If true, the model is asked to first emit a brief reasoning block
   * before invoking the tool (CoT). We don't parse it — we just allow it.
   */
  allowThinking: boolean;
}
