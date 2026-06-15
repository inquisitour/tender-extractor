import OpenAI from "openai";
import { createLogger } from "../utils/logger.js";
import { hashPrompt, loadFromCache, saveToCache } from "../ingestion/cache.js";
import "dotenv/config";

const log = createLogger("llmClient");

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
});

const DEFAULT_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: number;
  fromCache: boolean;
}

// callLLM: sends messages to the LLM, caches the response
export async function callLLM(
  messages: LLMMessage[],
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    useCache?: boolean;
  } = {}
): Promise<LLMResponse> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 8192; // set high to avoid truncation of structured output
  const temperature = options.temperature ?? 0.1; // low temp for structured output
  const useCache = options.useCache ?? true;

  // Build cache key from the full prompt
  const promptKey = hashPrompt(
    JSON.stringify({ messages, model, maxTokens, temperature }),
    model
  );

  // Check cache
  if (useCache) {
    const cached = await loadFromCache<LLMResponse>(promptKey);
    if (cached) {
      log.debug({ model }, "LLM response served from cache");
      return { ...cached, fromCache: true };
    }
  }

  log.debug({ model, messages: messages.length }, "Calling LLM");

  const completion = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  });

  const content = completion.choices[0]?.message?.content ?? "";
  const tokensUsed = completion.usage?.total_tokens ?? 0;

  const response: LLMResponse = {
    content,
    model,
    tokensUsed,
    fromCache: false,
  };

  log.debug({ model, tokensUsed }, "LLM response received");

  if (useCache) {
    await saveToCache(promptKey, response);
  }

  return response;
}

// parseJsonResponse: safely extracts JSON from LLM output
// Handles markdown fences that some models include despite instructions
export function parseJsonResponse<T>(raw: string): T {
  // Strip any markdown fences
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    log.error({ raw: raw.slice(0, 500), err }, "Failed to parse LLM JSON response");
    throw new Error(`LLM returned non-JSON response: ${raw.slice(0, 200)}`);
  }
}