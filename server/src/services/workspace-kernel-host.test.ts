import { afterEach, describe, expect, it } from "vitest";
import { SshWorkspaceAdapter } from "./workspace.js";
import type { SshConnection } from "../types.js";

function makeConnection(overrides: Partial<SshConnection> = {}): SshConnection {
  return {
    id: "conn-1",
    name: "test",
    host: "example.invalid",
    port: 22,
    username: "tester",
    knownHostsMode: "strict",
    enabled: true,
    allowBash: true,
    allowFileWrite: true,
    allowAbsolutePaths: false,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  };
}

const previousFlag = process.env.PORRIMA_REMOTE_KERNEL;
const restoreFlag = () => {
  if (previousFlag === undefined) delete process.env.PORRIMA_REMOTE_KERNEL;
  else process.env.PORRIMA_REMOTE_KERNEL = previousFlag;
};

afterEach(restoreFlag);

describe("SshWorkspaceAdapter.createKernelHost (P4a gate)", () => {
  it("returns null while the feature flag is off (ship dark)", async () => {
    delete process.env.PORRIMA_REMOTE_KERNEL;
    const adapter = new SshWorkspaceAdapter(makeConnection(), "/srv/work");
    expect(await adapter.createKernelHost()).toBeNull();
  });

  it("returns null when the flag is on but bash is disabled", async () => {
    process.env.PORRIMA_REMOTE_KERNEL = "1";
    const adapter = new SshWorkspaceAdapter(makeConnection({ allowBash: false }), "/srv/work");
    expect(await adapter.createKernelHost()).toBeNull();
  });

  it("supplies a transport host with the ssh kind when enabled", async () => {
    process.env.PORRIMA_REMOTE_KERNEL = "1";
    const adapter = new SshWorkspaceAdapter(makeConnection(), "/srv/work");
    const host = await adapter.createKernelHost();
    expect(host).not.toBeNull();
    expect(host!.kind).toBe("ssh:tester@example.invalid");
    expect(host!.failureReason).toBe("transport");
    // P4b: the host must own the model-side spill delivery surface.
    expect(typeof host!.deliverJobOutput).toBe("function");
  });
});
