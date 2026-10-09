/**
 * Permission gate: evaluates capability requests against the local policy. First matching rule
 * wins; otherwise the per-capability default applies. "ask" uses the client's consent prompt when
 * available (MCP elicitation) and is denied otherwise. Every decision is audited.
 */
import {
  PermissionDeniedError,
  describeCapability,
  type CapabilityRequest,
  type EventBus,
  type Logger,
  type PermissionContext,
  type PermissionDecision,
  type PermissionGate,
} from "@lmp/core";
import type { PermissionPolicy, PermissionRule } from "../config.js";
import type { PlatformEvents } from "../events.js";
import { canonicalizePath, isWithin, wildcardMatch } from "./paths.js";

export interface AuditSink {
  record(entry: {
    readonly tool: string;
    readonly requestId: string;
    readonly client: string;
    readonly kind: string;
    readonly target: string | null;
    readonly effect: "allow" | "deny";
    readonly rule: string;
  }): void;
}

const PATH_KINDS = new Set(["fs.read", "fs.write", "database.read", "database.write"]);
const MAX_REMEMBERED = 2000;

interface CompiledRule {
  readonly index: number;
  readonly rule: PermissionRule;
  /** Canonical roots for path capabilities. */
  readonly roots?: readonly string[];
}

export class PolicyPermissionGate implements PermissionGate {
  private compiled: readonly CompiledRule[] = [];
  private policy: PermissionPolicy;
  private readonly approvals = new Map<string, true>();
  private ready: Promise<void>;

  constructor(
    policy: PermissionPolicy,
    private readonly platform: NodeJS.Platform,
    private readonly audit: AuditSink,
    private readonly events: EventBus<PlatformEvents>,
    private readonly logger: Logger,
    private readonly configFile: string,
  ) {
    this.policy = policy;
    this.ready = this.compile(policy);
  }

  /** Applies a new policy (hot reload). Remembered approvals are dropped. */
  update(policy: PermissionPolicy): Promise<void> {
    this.policy = policy;
    this.approvals.clear();
    this.ready = this.compile(policy);
    return this.ready;
  }

  /** Canonical form of a path target; tools should operate on this exact path. */
  canonicalPath(target: string): Promise<string> {
    return canonicalizePath(target, { platform: this.platform });
  }

  async authorize(requests: readonly CapabilityRequest[], context: PermissionContext): Promise<readonly PermissionDecision[]> {
    await this.ready;
    const decisions: PermissionDecision[] = [];
    for (const original of requests) {
      const request = PATH_KINDS.has(original.kind) && original.target
        ? { ...original, target: await canonicalizePath(original.target, { platform: this.platform }) }
        : original;
      const { effect, rule } = this.evaluate(request, context.tool);
      let final: "allow" | "deny" = effect === "ask" ? "deny" : effect;
      let ruleName = rule;
      if (effect === "ask") {
        const key = `${context.tool}\u0000${request.kind}\u0000${request.target ?? ""}`;
        if (this.policy.rememberApprovals && this.approvals.has(key)) {
          final = "allow";
          ruleName = `${rule} (remembered approval)`;
        } else if (context.consent) {
          const approved = await context.consent(this.consentMessage(request, context.tool), request).catch((error: unknown) => {
            this.logger.warn("consent prompt failed", { error, tool: context.tool });
            return false;
          });
          final = approved ? "allow" : "deny";
          ruleName = `${rule} (${approved ? "approved" : "declined"} by user)`;
          if (approved && this.policy.rememberApprovals) this.remember(key);
        } else {
          ruleName = `${rule} (approval required, client cannot ask)`;
        }
      }
      const decision: PermissionDecision = { request, effect: final, rule: ruleName };
      decisions.push(decision);
      this.audit.record({
        tool: context.tool,
        requestId: context.requestId,
        client: context.client,
        kind: request.kind,
        target: request.target ?? null,
        effect: final,
        rule: ruleName,
      });
      this.events.emit("permission.decided", {
        tool: context.tool,
        requestId: context.requestId,
        kind: request.kind,
        ...(request.target !== undefined ? { target: request.target } : {}),
        effect: final,
        rule: ruleName,
      });
      if (final === "deny") throw this.denial(request, effect === "ask");
    }
    return decisions;
  }

  private evaluate(request: CapabilityRequest, tool: string): { effect: "allow" | "deny" | "ask"; rule: string } {
    for (const compiled of this.compiled) {
      const { rule } = compiled;
      if (rule.capability !== request.kind) continue;
      if (rule.tools && !rule.tools.includes(tool)) continue;
      if (!this.matchesTarget(compiled, request)) continue;
      return { effect: rule.effect, rule: rule.description ? `rule #${compiled.index + 1}: ${rule.description}` : `rule #${compiled.index + 1}` };
    }
    return { effect: this.policy.defaults[request.kind], rule: `default for ${request.kind}` };
  }

  private matchesTarget(compiled: CompiledRule, request: CapabilityRequest): boolean {
    if (!compiled.rule.targets) return true;
    if (request.target === undefined) return false;
    const target = request.target;
    if (compiled.roots) return compiled.roots.some((root) => isWithin(root, target, this.platform));
    return compiled.rule.targets.some((pattern) => wildcardMatch(pattern, target));
  }

  private async compile(policy: PermissionPolicy): Promise<void> {
    const out: CompiledRule[] = [];
    for (const [index, rule] of policy.rules.entries()) {
      if (PATH_KINDS.has(rule.capability) && rule.targets) {
        const roots: string[] = [];
        for (const root of rule.targets) {
          try {
            roots.push(await canonicalizePath(root, { platform: this.platform }));
          } catch (error) {
            this.logger.warn("ignoring invalid permission root", { rule: index + 1, root, error });
          }
        }
        out.push({ index, rule, roots });
      } else {
        out.push({ index, rule });
      }
    }
    this.compiled = out;
  }

  private remember(key: string): void {
    if (this.approvals.size >= MAX_REMEMBERED) {
      const oldest = this.approvals.keys().next();
      if (!oldest.done) this.approvals.delete(oldest.value);
    }
    this.approvals.set(key, true);
  }

  private consentMessage(request: CapabilityRequest, tool: string): string {
    const why = request.reason ? ` Purpose: ${request.reason}.` : "";
    return `Allow tool "${tool}" to use ${describeCapability(request)}?${why}`;
  }

  private denial(request: CapabilityRequest, wasAsk: boolean): PermissionDeniedError {
    const what = describeCapability(request);
    const how = wasAsk
      ? `Approval is required. Approve it when asked, or add an "allow" rule for "${request.kind}" in ${this.configFile}.`
      : `Blocked by the local permission policy (${this.configFile}).`;
    return new PermissionDeniedError(`Permission denied: ${what}. ${how}`, {
      details: { kind: request.kind, ...(request.target !== undefined ? { target: request.target } : {}) },
    });
  }
}
