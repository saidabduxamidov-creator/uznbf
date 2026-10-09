/**
 * Product identity. The platform name is temporary; every user-visible name, directory name and
 * identifier is derived from this single object so a rename touches one file.
 */
export const PRODUCT = Object.freeze({
  /** Short machine identifier: environment-variable prefix, bridge discovery names. */
  id: "lmp",
  /** Human-readable name shown to MCP clients. */
  displayName: "Local MCP Platform",
  /** Directory name under the per-user data/config roots. */
  directoryName: "LocalMcpPlatform",
  /** MCP server name announced in `initialize`. */
  serverName: "local-mcp-platform",
  version: "0.1.0",
});

export const ENV_PREFIX = `${PRODUCT.id.toUpperCase()}_`;
