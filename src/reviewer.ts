import { z } from "zod";
import { classifyHttpError, ProviderError } from "./errors.js";
import type { LLMProvider, ReviewResult } from "./types.js";

const ReviewResultSchema = z.object({
  summary: z.string(),
  concerns: z.array(z.string()),
  recommendation: z.enum(["merge", "revise", "close"]),
  confidence: z.number().min(0).max(1),
});

interface LLMConfig {
  provider: string;
  apiKey?: string;
  model: string;
}

class OpenAILLM implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: LLMConfig & { baseUrl?: string }) {
    if (!config.apiKey) throw new Error("LLM_API_KEY required");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.3 }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("LLM", resp.status, body, { apiKeyEnvVar: "LLM_API_KEY" });
    }
    const data = (await resp.json()) as any;
    if (!data.choices?.length) {
      throw new ProviderError(
        "LLM",
        "Empty response from model (no choices returned)",
        "The model may be overloaded or refusing to respond. Try again or use a different model",
      );
    }
    return data.choices[0].message.content;
  }

  async completeJSON<T>(prompt: string, systemPrompt?: string): Promise<T> {
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("LLM", resp.status, body, { apiKeyEnvVar: "LLM_API_KEY" });
    }
    const data = (await resp.json()) as any;
    if (!data.choices?.length) {
      throw new ProviderError(
        "LLM",
        "Empty response from model (no choices returned)",
        "The model may be overloaded or refusing to respond. Try again or use a different model",
      );
    }
    return JSON.parse(data.choices[0].message.content);
  }
}

function createLLMProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAILLM(config);
    case "kimi":
      return new OpenAILLM({ ...config, baseUrl: "https://api.moonshot.cn/v1" } as any);
    case "opencode":
      return new OpenAILLM({ ...config, baseUrl: "https://opencode.ai/zen/v1" } as any);
    case "anthropic":
      return new AnthropicLLM(config);
    case "ollama":
      return new OpenAILLM({ ...config, baseUrl: "http://localhost:11434/v1", apiKey: "ollama" } as any);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

class AnthropicLLM implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(config: LLMConfig) {
    if (!config.apiKey) throw new Error("LLM_API_KEY required for Anthropic");
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const body: any = {
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw classifyHttpError("Anthropic", resp.status, body, { apiKeyEnvVar: "LLM_API_KEY" });
    }
    const data = (await resp.json()) as any;
    if (!data.content?.length) {
      throw new ProviderError(
        "Anthropic",
        "Empty response from model (no content returned)",
        "The model may be overloaded or refusing to respond. Try again or use a different model",
      );
    }
    return data.content[0].text;
  }

  async completeJSON<T>(prompt: string, systemPrompt?: string): Promise<T> {
    const text = await this.complete(prompt, systemPrompt);
    // Extract JSON from response (Anthropic doesn't have JSON mode)
    // Use balanced brace extraction instead of greedy regex
    const startIdx = text.indexOf("{");
    if (startIdx === -1) throw new Error("Failed to extract JSON from Anthropic response");
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) throw new Error("Failed to extract JSON from Anthropic response");
    return JSON.parse(text.slice(startIdx, endIdx + 1));
  }
}

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer analyzing a GitHub pull request. You must respond with valid JSON matching this exact schema:
{
  "summary": "Brief description of what this PR does",
  "concerns": ["List of specific concerns or issues"],
  "recommendation": "merge" | "revise" | "close",
  "confidence": 0.0-1.0
}

Be concise, specific, and objective. Focus on:
- Code quality and correctness
- Test coverage
- Potential breaking changes
- Security implications
- Whether it duplicates existing functionality`;

export async function reviewPR(title: string, body: string, diff: string, llmConfig: LLMConfig): Promise<ReviewResult> {
  const llm = createLLMProvider(llmConfig);

  // Cap diff to avoid token limits
  const truncatedDiff = diff.length > 50_000 ? `${diff.slice(0, 50_000)}\n\n[DIFF TRUNCATED]` : diff;

  const prompt = `## PR: ${title}

### Description
${body || "(No description provided)"}

### Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

Analyze this PR and respond with JSON only.`;

  let result: unknown;
  try {
    result = await llm.completeJSON(prompt, REVIEW_SYSTEM_PROMPT);
  } catch {
    // Fallback: try plain completion and parse
    const text = await llm.complete(prompt, REVIEW_SYSTEM_PROMPT);
    const si = text.indexOf("{");
    if (si === -1) throw new Error("LLM did not return valid JSON");
    let d = 0,
      ei = -1;
    for (let i = si; i < text.length; i++) {
      if (text[i] === "{") d++;
      else if (text[i] === "}") d--;
      if (d === 0) {
        ei = i;
        break;
      }
    }
    if (ei === -1) throw new Error("LLM did not return valid JSON");
    result = JSON.parse(text.slice(si, ei + 1));
  }

  return ReviewResultSchema.parse(result);
}
