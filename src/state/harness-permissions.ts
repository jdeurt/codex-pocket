import { object, string } from "../lib/protocol";
import type { ParentPolicy } from "../server/harness/types";

/**
Validate the parent's effective native access policy before allowing it to be inherited.
@param config - Native effective configuration normalized at the protocol boundary.
@returns Inherited sandbox, approval, model, effort and workspace policy.
*/
export function parentPolicy(config: Record<string, unknown>): ParentPolicy {
  const sandbox = string(config.sandbox_mode);
  const approval = config.approval_policy;

  if (!approval || !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) {
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

/**
Map the validated parent policy into the native Codex session fields without broadening access.
@param policy - Validated effective parent policy.
@returns Native sandbox and approval fields, including existing workspace restrictions.
*/
export function codexPermissions(policy: ParentPolicy) {
  return {
    sandbox: policy.sandbox,
    approvalPolicy: policy.approval,
    config: { sandbox_workspace_write: policy.workspace ?? {} },
  };
}

/**
Allow Claude only when the native parent policy has an exact unrestricted mapping.
@param policy - Validated parent policy whose sandbox and approval mode must be preserved.
@returns Native unrestricted Claude permission options, or the existing unsupported-mapping error.
*/
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
