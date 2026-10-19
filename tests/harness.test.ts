import { claudePermissions, codexPermissions, parentPolicy } from "../src/server/harness/permissions";
import assert from "node:assert/strict";
import { codexParentTools } from "../src/server/harness/mcp-config";
import test from "node:test";

test("delegates map full parent access explicitly, and reject incompatible Claude policies", () => {
  const policy = parentPolicy({ sandbox_mode: "danger-full-access", approval_policy: "never" });
  assert.deepEqual(claudePermissions(policy), {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    sandbox: { enabled: false },
  });
  assert.equal(codexPermissions(policy).sandbox, "danger-full-access");
  assert.equal(codexPermissions(policy).approvalPolicy, "never");
  assert.throws(() => claudePermissions({ ...policy, sandbox: "workspace-write" }), /cannot exactly map/);
  assert.throws(() => claudePermissions({ ...policy, approval: "on-request" }), /cannot exactly map/);
  assert.throws(() => parentPolicy({}), /Cannot determine/);
});

test("child Codex configuration disables the main Pocket server and adds parent messaging", () => {
  const args = codexParentTools({ command: "/node", args: ["parent.ts"], env: { CHILD_ID: "child" } });
  assert.equal(args[1], "mcp_servers.pocket.enabled=false");
  assert.equal(args.includes('mcp_servers.pocket_parent.command="/node"'), true);
  assert.equal(args.includes('mcp_servers.pocket_parent.env.CHILD_ID="child"'), true);
  assert.equal(
    args.some((value) => value.includes("schedule")),
    false
  );
});
