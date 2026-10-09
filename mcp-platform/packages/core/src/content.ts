/**
 * Tool output content, independent of the MCP SDK. The MCP adapter maps these parts 1:1 to
 * protocol content blocks. Binary data is base64; large artifacts should be resource links.
 */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContent {
  readonly type: "image";
  /** Base64-encoded image bytes. */
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface ResourceLinkContent {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly description?: string;
}

export type ContentPart = TextContent | ImageContent | ResourceLinkContent;

export const text = (value: string): TextContent => ({ type: "text", text: value });

export const image = (data: string, mimeType: ImageContent["mimeType"]): ImageContent => ({ type: "image", data, mimeType });

export const resourceLink = (
  uri: string,
  name: string,
  extra: { readonly mimeType?: string; readonly description?: string } = {},
): ResourceLinkContent => ({ type: "resource_link", uri, name, ...extra });
