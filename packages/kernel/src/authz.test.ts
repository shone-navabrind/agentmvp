import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Authz, UnknownCapability, type Decision, type Subject } from "./authz.ts";
import { KernelError } from "./types.ts";

const CAPS = [
  "project:read",
  "project:chat",
  "project:terminal:open",
  "project:files:write",
  "workspace:members:manage",
  "workspace:budget:manage",
  "plugin:install",
] as const;

function policy(onDecision?: (d: Decision, s: Subject, r: Parameters<Authz["can"]>[2]) => void) {
  return new Authz({ onDecision })
    .defineCapability(...CAPS)
    .defineRole("member", ["project:read", "project:chat"])
    .defineRole("admin", [
      "project:read",
      "project:chat",
      "project:terminal:open",
      "project:files:write",
      "workspace:members:manage",
      "workspace:budget:manage",
    ])
    .defineRole("superadmin", [...CAPS]);
}

const member: Subject = {
  kind: "user",
  id: "u-member",
  assignments: [{ role: "member", scope: "workspace", scopeId: "ws1" }],
};
const memberWithTerminal: Subject = {
  kind: "user",
  id: "u-granted",
  assignments: [
    { role: "member", scope: "workspace", scopeId: "ws1" },
    { capability: "project:terminal:open", scope: "project", scopeId: "p1" },
  ],
};
const admin: Subject = {
  kind: "user",
  id: "u-admin",
  assignments: [{ role: "admin", scope: "workspace", scopeId: "ws1" }],
};
const superadmin: Subject = {
  kind: "user",
  id: "u-super",
  assignments: [{ role: "superadmin", scope: "tenant", scopeId: "t1" }],
};
const agent: Subject = {
  kind: "agent",
  id: "sess-1",
  assignments: [{ capability: "project:files:write", scope: "project", scopeId: "p1" }],
};
const plugin: Subject = {
  kind: "plugin",
  id: "acme.jira",
  assignments: [{ capability: "project:read", scope: "workspace", scopeId: "ws1" }],
};

const P1 = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };
const P2 = { tenantId: "t1", workspaceId: "ws1", projectId: "p2" };
const OTHER_WS = { tenantId: "t1", workspaceId: "ws2", projectId: "p9" };
const OTHER_TENANT = { tenantId: "t2", workspaceId: "ws9", projectId: "p9" };

describe("authz", () => {
  const az = policy();

  // Table-driven: this IS the role matrix from the architecture doc, executable.
  const matrix: Array<[string, Subject, string, typeof P1, boolean]> = [
    ["member can read own-workspace project", member, "project:read", P1, true],
    ["member can chat", member, "project:chat", P1, true],
    ["member CANNOT open a terminal", member, "project:terminal:open", P1, false],
    ["member CANNOT write files", member, "project:files:write", P1, false],
    ["member CANNOT manage members", member, "workspace:members:manage", P1, false],
    ["member CANNOT reach another workspace", member, "project:read", OTHER_WS, false],
    ["member CANNOT reach another tenant", member, "project:read", OTHER_TENANT, false],

    ["granted member CAN open terminal on p1", memberWithTerminal, "project:terminal:open", P1, true],
    ["...but NOT on p2", memberWithTerminal, "project:terminal:open", P2, false],

    ["admin can open any terminal in the workspace", admin, "project:terminal:open", P2, true],
    ["admin can manage budget", admin, "workspace:budget:manage", P1, true],
    ["admin CANNOT install plugins", admin, "plugin:install", P1, false],
    ["admin CANNOT reach another workspace", admin, "project:terminal:open", OTHER_WS, false],

    ["superadmin can install plugins", superadmin, "plugin:install", P1, true],
    ["superadmin spans the tenant", superadmin, "project:terminal:open", OTHER_WS, true],
    ["superadmin stops at the tenant boundary", superadmin, "project:read", OTHER_TENANT, false],

    ["agent session can write files in its project", agent, "project:files:write", P1, true],
    ["agent session cannot write in another project", agent, "project:files:write", P2, false],
    ["agent session cannot open a terminal", agent, "project:terminal:open", P1, false],

    ["plugin can read what it declared", plugin, "project:read", P1, true],
    ["plugin cannot exceed its declared capabilities", plugin, "project:files:write", P1, false],
  ];

  for (const [name, subject, cap, resource, expected] of matrix) {
    test(name, () => {
      assert.equal(az.can(subject, cap, resource).allowed, expected);
    });
  }

  test("an unregistered capability is an error, never a silent deny", () => {
    assert.throws(() => az.can(admin, "project:teleport", P1), UnknownCapability);
  });

  test("defining a role with an unknown capability fails at boot", () => {
    assert.throws(
      () => new Authz().defineCapability("a").defineRole("r", ["a", "b"]),
      UnknownCapability,
    );
  });

  test("assert() throws FORBIDDEN with the reason attached", () => {
    try {
      az.assert(member, "project:terminal:open", P1);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof KernelError);
      assert.equal(err.code, "FORBIDDEN");
      assert.equal(err.details.capability, "project:terminal:open");
    }
  });

  test("every decision is observable, so denials can be audited", () => {
    const seen: Decision[] = [];
    const audited = policy((d) => seen.push(d));
    audited.can(member, "project:terminal:open", P1);
    audited.can(admin, "project:terminal:open", P1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].allowed, false);
    assert.equal(seen[0].reason, "no assignment grants this capability at a covering scope");
    assert.equal(seen[1].allowed, true);
    assert.match(seen[1].reason, /granted by admin @ workspace/);
  });
});
