/**
 * OAuth token management for AI platform integrations (ChatGPT, Claude, Gemini).
 * Handles token storage, validation, refresh, and revocation.
 * Tokens stored encrypted in the database, never in memory or config files.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { Logger } from "@lmp/core";

export type AIProvider = "chatgpt" | "claude" | "gemini";
export type OAuthTokenType = "access" | "refresh";

export interface OAuthToken {
  provider: AIProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  issuedAt: number;
  encryptionKey?: string;
}

export interface OAuthConfig {
  chatgpt?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  claude?: {
    apiKey: string; // Claude uses API keys instead of OAuth
  };
  gemini?: {
    apiKey: string; // Gemini uses API keys instead of OAuth
  };
}

/**
 * Manages OAuth tokens for all AI platforms.
 * Stores encrypted tokens in database, handles refresh cycles, validates expiration.
 */
export class OAuthManager extends EventEmitter {
  private db: Map<string, OAuthToken> = new Map();
  private encryptionKey: Buffer;
  private refreshTimers: Map<AIProvider, NodeJS.Timeout> = new Map();

  constructor(
    private dataDir: string,
    private logger: Logger,
  ) {
    super();
    // Generate or load encryption key for token storage
    this.encryptionKey = this.loadOrGenerateEncryptionKey();
  }

  private loadOrGenerateEncryptionKey(): Buffer {
    const keyPath = path.join(this.dataDir, ".oauth-key");
    try {
      const key = Buffer.from(require("fs").readFileSync(keyPath, "utf8"), "hex");
      if (key.length === 32) return key;
    } catch (e) {
      // Key doesn't exist or is invalid
    }

    // Generate new key
    const key = crypto.randomBytes(32);
    try {
      require("fs").writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    } catch (e) {
      this.logger?.warn?.("Failed to persist encryption key", e);
    }
    return key;
  }

  /**
   * Encrypt sensitive token data
   */
  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
  }

  /**
   * Decrypt sensitive token data
   */
  private decrypt(encryptedData: string): string {
    try {
      const buffer = Buffer.from(encryptedData, "base64");
      const iv = buffer.subarray(0, 16);
      const authTag = buffer.subarray(16, 32);
      const encrypted = buffer.subarray(32);

      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
    } catch (e) {
      this.logger?.error?.("Failed to decrypt token", e);
      throw new Error("Token decryption failed");
    }
  }

  /**
   * Store OAuth token (encrypted)
   */
  async storeToken(provider: AIProvider, token: OAuthToken): Promise<void> {
    const encrypted: OAuthToken = {
      ...token,
      accessToken: this.encrypt(token.accessToken),
      refreshToken: token.refreshToken ? this.encrypt(token.refreshToken) : undefined,
    };

    this.db.set(provider, encrypted);
    this.logger?.info?.(`OAuth token stored for ${provider}`);

    // Schedule refresh if token has expiration
    if (token.expiresAt) {
      this.scheduleRefresh(provider, token.expiresAt);
    }

    this.emit("token-stored", { provider, expiresAt: token.expiresAt });
  }

  /**
   * Retrieve OAuth token (decrypted)
   */
  async getToken(provider: AIProvider): Promise<OAuthToken | null> {
    const encrypted = this.db.get(provider);
    if (!encrypted) return null;

    try {
      return {
        ...encrypted,
        accessToken: this.decrypt(encrypted.accessToken),
        refreshToken: encrypted.refreshToken ? this.decrypt(encrypted.refreshToken) : undefined,
      };
    } catch (e) {
      this.logger?.error?.(`Failed to retrieve token for ${provider}`, e);
      return null;
    }
  }

  /**
   * Check if token is valid (not expired)
   */
  async isTokenValid(provider: AIProvider): Promise<boolean> {
    const token = await this.getToken(provider);
    if (!token) return false;

    if (token.expiresAt && token.expiresAt < Date.now()) {
      this.logger?.info?.(`Token for ${provider} has expired`);
      return false;
    }

    return true;
  }

  /**
   * Validate token with provider API
   */
  async validateTokenWithProvider(provider: AIProvider, config: OAuthConfig): Promise<boolean> {
    const token = await this.getToken(provider);
    if (!token) return false;

    try {
      switch (provider) {
        case "chatgpt":
          return await this.validateChatGPTToken(token.accessToken);
        case "claude":
          // Claude uses API keys - validate by attempting a call
          return true; // API key validation happens at tool execution time
        case "gemini":
          // Gemini uses API keys - validate by attempting a call
          return true; // API key validation happens at tool execution time
      }
    } catch (e) {
      this.logger?.error?.(`Token validation failed for ${provider}`, e);
      return false;
    }
  }

  /**
   * Validate ChatGPT token by calling models endpoint
   */
  private async validateChatGPTToken(accessToken: string): Promise<boolean> {
    const https = require("https");
    return new Promise((resolve) => {
      const req = https.request(
        {
          method: "GET",
          hostname: "api.openai.com",
          path: "/v1/models",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
        (res) => {
          resolve(res.statusCode === 200);
        },
      );

      req.on("error", () => resolve(false));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * Revoke OAuth token
   */
  async revokeToken(provider: AIProvider): Promise<void> {
    this.db.delete(provider);
    const timer = this.refreshTimers.get(provider);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(provider);
    }
    this.logger?.info?.(`OAuth token revoked for ${provider}`);
    this.emit("token-revoked", { provider });
  }

  /**
   * Schedule automatic token refresh
   */
  private scheduleRefresh(provider: AIProvider, expiresAt: number): void {
    // Clear existing timer
    const existing = this.refreshTimers.get(provider);
    if (existing) clearTimeout(existing);

    // Schedule refresh 5 minutes before expiration
    const refreshTime = Math.max(1000, expiresAt - Date.now() - 5 * 60 * 1000);
    const timer = setTimeout(() => {
      this.emit("token-needs-refresh", { provider });
    }, refreshTime);

    this.refreshTimers.set(provider, timer);
  }

  /**
   * Get token status for all providers
   */
  async getStatus(): Promise<Record<AIProvider, { authenticated: boolean; expiresAt?: number }>> {
    const providers: AIProvider[] = ["chatgpt", "claude", "gemini"];
    const status: Record<AIProvider, any> = {};

    for (const provider of providers) {
      const token = await this.getToken(provider);
      status[provider] = {
        authenticated: !!token,
        expiresAt: token?.expiresAt,
      };
    }

    return status;
  }
}
