/**
 * OAuth endpoints for MCP server.
 * Handles authorization, token exchange, and credential management for ChatGPT, Claude, Gemini.
 */

import { createServer, type Server } from "node:http";
import { parse as parseUrl } from "node:url";
import { randomBytes } from "node:crypto";
import type { OAuthManager } from "@lmp/kernel";
import type { Logger } from "@lmp/core";

export interface OAuthConfig {
  chatgpt?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  claude?: {
    apiKey?: string;
  };
  gemini?: {
    apiKey?: string;
  };
}

/**
 * OAuth handler for token-based authentication with AI providers.
 * Supports ChatGPT (OAuth 2.1 with PKCE), Claude (API key), Gemini (API key).
 */
export class OAuthHandler {
  private server?: Server;
  private pendingFlows: Map<
    string,
    {
      provider: "chatgpt" | "claude" | "gemini";
      codeChallenge: string;
      state: string;
      createdAt: number;
    }
  > = new Map();

  constructor(
    private oauthManager: OAuthManager,
    private config: OAuthConfig,
    private logger: Logger,
  ) {}

  /**
   * Start HTTP server for OAuth callbacks
   */
  async start(port: number = 0): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((e) => {
          this.logger?.error?.("OAuth handler error", e);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal server error");
        });
      });

      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address === "object" && "port" in address && address.port) {
          const url = `http://127.0.0.1:${address.port}`;
          this.logger?.info?.(`OAuth handler listening on ${url}`);
          resolve({ port: address.port, url });
        } else {
          reject(new Error("Failed to determine server port"));
        }
      });

      this.server.on("error", reject);
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: any, res: any): Promise<void> {
    const url = parseUrl(req.url || "", true);
    const pathname = url.pathname;

    // OAuth endpoints
    if (pathname === "/oauth/chatgpt/authorize") {
      return this.handleChatGPTAuthorize(req, res, url.query);
    }

    if (pathname === "/oauth/chatgpt/callback") {
      return this.handleChatGPTCallback(req, res, url.query);
    }

    if (pathname === "/oauth/status") {
      return this.handleStatusRequest(req, res);
    }

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Not found
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  /**
   * Initiate ChatGPT OAuth flow (PKCE)
   */
  private handleChatGPTAuthorize(_req: any, res: any, _query: any): void {
    if (!this.config.chatgpt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ChatGPT not configured" }));
      return;
    }

    // Generate PKCE challenge
    const codeVerifier = randomBytes(32).toString("hex");
    const state = randomBytes(16).toString("hex");

    // Store flow state
    this.pendingFlows.set(state, {
      provider: "chatgpt",
      codeChallenge: codeVerifier,
      state,
      createdAt: Date.now(),
    });

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.config.chatgpt.clientId,
      redirect_uri: this.config.chatgpt.redirectUri,
      response_type: "code",
      scope: "user-read profile",
      state,
      code_challenge: codeVerifier,
      code_challenge_method: "plain", // In production, use S256 with SHA256
    });

    const authUrl = `https://platform.openai.com/oauth/authorize?${params.toString()}`;

    // Redirect to OpenAI
    res.writeHead(302, { Location: authUrl });
    res.end();
  }

  /**
   * Handle ChatGPT OAuth callback
   */
  private async handleChatGPTCallback(_req: any, res: any, query: any): Promise<void> {
    const { code, state, error } = query;

    if (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error, error_description: query.error_description }));
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing code or state" }));
      return;
    }

    const flow = this.pendingFlows.get(state);
    if (!flow) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid state" }));
      return;
    }

    // Clean up
    this.pendingFlows.delete(state);

    try {
      // Exchange code for token
      const tokenResponse = await this.exchangeCodeForToken("chatgpt", code, flow.codeChallenge);

      // Store token
      await this.oauthManager.storeToken("chatgpt", {
        provider: "chatgpt",
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
        scopes: tokenResponse.scope?.split(" ") || [],
        issuedAt: Date.now(),
      });

      // Success response
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <head><title>ChatGPT Connected</title></head>
          <body>
            <h1>✓ ChatGPT Connected Successfully</h1>
            <p>Token received and stored. You can close this window.</p>
            <p>The Puligin panel will automatically detect the connection.</p>
          </body>
        </html>
      `);

      this.logger?.info?.("ChatGPT OAuth successful");
    } catch (e) {
      this.logger?.error?.("Token exchange failed", { error: String(e) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token exchange failed", details: String(e) }));
    }
  }

  /**
   * Handle status request
   */
  private async handleStatusRequest(_req: any, res: any): Promise<void> {
    const status = await this.oauthManager.getStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }

  /**
   * Exchange authorization code for access token
   */
  private async exchangeCodeForToken(
    provider: string,
    code: string,
    codeVerifier: string,
  ): Promise<any> {
    const https = require("https");

    if (provider !== "chatgpt" || !this.config.chatgpt) {
      throw new Error(`Provider ${provider} not supported`);
    }

    const params = new URLSearchParams({
      client_id: this.config.chatgpt.clientId,
      client_secret: this.config.chatgpt.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: this.config.chatgpt.redirectUri,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "POST",
          hostname: "api.openai.com",
          path: "/oauth/token",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(params.toString()),
          },
        },
        (res: any) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const response = JSON.parse(data);
              if (res.statusCode !== 200) {
                reject(new Error(`Token exchange failed: ${response.error}`));
              } else {
                resolve(response);
              }
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error("Token exchange timeout"));
      });

      req.write(params.toString());
      req.end();
    });
  }

  /**
   * Stop the OAuth server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger?.info?.("OAuth handler stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
