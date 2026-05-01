import { extract, type ExtractResult, type LlmClient } from "@test-evals/llm";
import { getStrategy } from "@test-evals/llm";
import type { Strategy } from "@test-evals/shared";

export interface ExtractServiceParams {
  client: LlmClient;
  strategy: Strategy;
  model: string;
  transcript: string;
}

export async function runExtraction(p: ExtractServiceParams): Promise<ExtractResult> {
  const strategy = getStrategy(p.strategy);
  return extract({
    client: p.client,
    strategy,
    model: p.model,
    transcript: p.transcript,
  });
}
