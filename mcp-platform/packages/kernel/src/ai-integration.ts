/**
 * AI platform integrations for ChatGPT, Claude, and Gemini.
 * Calls AI services using authenticated tokens from OAuthManager.
 */

import { https } from "node:https";
import type { Logger } from "@lmp/core";
import type { OAuthManager, AIProvider } from "./oauth.js";

export interface AICallOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  abortSignal?: AbortSignal;
}

export interface AIResponse {
  provider: AIProvider;
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
}

/**
 * Unified interface for calling multiple AI platforms
 */
export class AIIntegration {
  constructor(
    private oauthManager: OAuthManager,
    private logger: Logger,
  ) {}

  /**
   * Call ChatGPT API
   */
  async callChatGPT(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    options: AICallOptions & { model?: string } = {},
  ): Promise<AIResponse> {
    const token = await this.oauthManager.getToken("chatgpt");
    if (!token) throw new Error("ChatGPT token not available. Please connect ChatGPT.");

    const isValid = await this.oauthManager.isTokenValid("chatgpt");
    if (!isValid) throw new Error("ChatGPT token has expired. Please reconnect.");

    const url = new URL("https://api.openai.com/v1/chat/completions");

    const payload = {
      model: options.model || "gpt-4-turbo",
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 2048,
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            Authorization: `Bearer ${token.accessToken}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) {
                throw new Error(`ChatGPT API error: ${res.statusCode} ${data}`);
              }
              const response = JSON.parse(data);
              resolve({
                provider: "chatgpt",
                content: response.choices[0]?.message?.content || "",
                usage: response.usage,
                model: response.model,
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(options.timeout || 30000, () => {
        req.destroy();
        reject(new Error("ChatGPT request timeout"));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Call Claude API using API key
   */
  async callClaude(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: AICallOptions & { model?: string; apiKey?: string } = {},
  ): Promise<AIResponse> {
    const token = await this.oauthManager.getToken("claude");
    const apiKey = options.apiKey || token?.accessToken;

    if (!apiKey) throw new Error("Claude API key not available. Please configure Claude.");

    const url = new URL("https://api.anthropic.com/v1/messages");

    const payload = {
      model: options.model || "claude-opus-5-5",
      max_tokens: options.maxTokens || 2048,
      system: options.systemPrompt,
      messages,
      temperature: options.temperature ?? 0.7,
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) {
                throw new Error(`Claude API error: ${res.statusCode} ${data}`);
              }
              const response = JSON.parse(data);
              resolve({
                provider: "claude",
                content: response.content[0]?.text || "",
                usage: response.usage,
                model: response.model,
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(options.timeout || 30000, () => {
        req.destroy();
        reject(new Error("Claude request timeout"));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Call Gemini API using API key
   */
  async callGemini(
    messages: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
    options: AICallOptions & { model?: string; apiKey?: string } = {},
  ): Promise<AIResponse> {
    const token = await this.oauthManager.getToken("gemini");
    const apiKey = options.apiKey || token?.accessToken;

    if (!apiKey) throw new Error("Gemini API key not available. Please configure Gemini.");

    const url = new URL(
      `https://generativelanguage.googleapis.com/v1/models/${options.model || "gemini-2.0-flash"}:generateContent`,
    );
    url.searchParams.set("key", apiKey);

    const payload = {
      contents: messages,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens || 2048,
      },
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) {
                throw new Error(`Gemini API error: ${res.statusCode} ${data}`);
              }
              const response = JSON.parse(data);
              const text = response.candidates[0]?.content?.parts[0]?.text || "";
              resolve({
                provider: "gemini",
                content: text,
                usage: {
                  promptTokens: response.usageMetadata?.promptTokenCount,
                  completionTokens: response.usageMetadata?.candidatesTokenCount,
                  totalTokens: response.usageMetadata?.totalTokenCount,
                },
                model: options.model,
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(options.timeout || 30000, () => {
        req.destroy();
        reject(new Error("Gemini request timeout"));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Get available models for each provider
   */
  async getAvailableModels(provider: AIProvider): Promise<string[]> {
    switch (provider) {
      case "chatgpt":
        return [
          "gpt-4-turbo",
          "gpt-4o",
          "gpt-4o-mini",
          "gpt-3.5-turbo",
        ];
      case "claude":
        return [
          "claude-opus-5-5",
          "claude-sonnet-4-20250514",
          "claude-haiku-3-5",
        ];
      case "gemini":
        return [
          "gemini-2.0-flash",
          "gemini-2.0-pro",
          "gemini-1.5-flash",
          "gemini-1.5-pro",
        ];
    }
  }
}
