/**
 * Capabilities are the unit of permission. A tool declares, per call, which capabilities it needs
 * and on which target (a path, an executable, a domain, a host application). The permission gate
 * decides each request against the local policy before the tool runs.
 */
export const CAPABILITY_KINDS = [
  "fs.read",
  "fs.write",
  "process.spawn",
  "terminal.exec",
  "network",
  "clipboard.read",
  "clipboard.write",
  "database.read",
  "database.write",
  "host",
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface CapabilityRequest {
  readonly kind: CapabilityKind;
  /**
   * The resource the capability applies to:
   * fs.* / database.* → absolute path, process.spawn / terminal.exec → executable,
   * network → hostname, host → host application id (e.g. "premiere"). Omitted for clipboard.
   */
  readonly target?: string;
  /** Short human-readable purpose, used in consent prompts and the audit log. */
  readonly reason?: string;
}

export function isCapabilityKind(value: string): value is CapabilityKind {
  return (CAPABILITY_KINDS as readonly string[]).includes(value);
}

export function describeCapability(request: CapabilityRequest): string {
  return request.target ? `${request.kind} → ${request.target}` : request.kind;
}
