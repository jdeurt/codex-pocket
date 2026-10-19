import { object, string } from "../../lib/protocol";
import type { ParentPolicy } from "./types";

export function parentPolicy(config: Record<string, unknown>): ParentPolicy {
  const sandbox = string(config.sandbox_mode);
  const approval = config.approval_policy;

  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox) || !approval) {
    throw new Error("Cannot determine the parent's effective sandbox and approval policy.");
  }

  return {
    sandbox,
    approval,
    model: string(config.model) || undefined,
    effort: string(config.model_reasoning_effort) || null,
    workspace: object(config.sandbox_workspace_write),
  };
}

export function codexPermissions(policy: ParentPolicy) {
  return {
    sandbox: policy.sandbox,
    approvalPolicy: policy.approval,
    config: { sandbox_workspace_write: policy.workspace ?? {} },
  };
}

export function claudePermissions(policy: ParentPolicy) {
  if (policy.sandbox !== "danger-full-access" || policy.approval !== "never") {
    throw new Error(
      "Claude Side Pockets require a parent with danger-full-access and approval_policy=never. " +
        "Pocket cannot exactly map this parent's restricted Codex policy to Claude."
    );
  }

  return {
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    sandbox: { enabled: false },
  };
}
