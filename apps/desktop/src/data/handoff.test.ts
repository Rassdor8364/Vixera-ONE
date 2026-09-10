import { describe, expect, it } from "vitest";
import { DEV_USER_ID, type Device, type Handoff } from "@vixera/domain";
import { describeHandoff, handoffPayload, pendingHandoffsFor, selectHandoffTargets } from "./handoff.ts";

const NOW = Date.parse("2026-09-10T09:00:00Z");

function device(id: string, name: string, lastSeenAt: string | null): Device {
  return { id: id as Device["id"], userId: DEV_USER_ID, platform: "windows", name, praxionAvailable: false, lastSeenAt, createdAt: "2026-09-01T00:00:00Z" };
}

function handoff(id: string, over: Partial<Handoff>): Handoff {
  return {
    id: id as Handoff["id"],
    userId: DEV_USER_ID,
    sourceDeviceId: "win" as Handoff["sourceDeviceId"],
    targetDeviceId: null,
    state: "pending",
    focus: null,
    threadId: null,
    documentId: null,
    artifactStoragePath: null,
    praxionLocation: null,
    conclusions: [],
    commandHistory: [],
    createdAt: new Date(NOW - 12 * 60_000).toISOString(),
    deliveredAt: null,
    acceptedAt: null,
    expiresAt: null,
    metadata: {},
    ...over,
  };
}

describe("handoff target selection", () => {
  it("offers only other devices, most recently seen first", () => {
    const devices = [device("win", "Windows", "2026-09-10T08:00:00Z"), device("droid", "Pixel", "2026-09-10T08:30:00Z"), device("old", "Old laptop", null)];
    expect(selectHandoffTargets(devices, "win").map((d) => d.name)).toEqual(["Pixel", "Old laptop"]);
    expect(selectHandoffTargets(devices, "droid").map((d) => d.name)).toEqual(["Windows", "Old laptop"]);
  });

  it("picks up open handoffs addressed to this device or to anyone, never its own", () => {
    const rows = [
      handoff("a", { targetDeviceId: "droid" as Handoff["targetDeviceId"] }),
      handoff("b", { targetDeviceId: null }),
      handoff("c", { targetDeviceId: "other" as Handoff["targetDeviceId"] }),
      handoff("d", { state: "accepted" }),
      handoff("e", { sourceDeviceId: "droid" as Handoff["sourceDeviceId"] }),
      handoff("f", { expiresAt: "2020-01-01T00:00:00Z" }),
    ];
    expect(pendingHandoffsFor(rows, "droid").map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("describes where and when the context was left", () => {
    const devices = [device("win", "Windows", null)];
    expect(describeHandoff(handoff("a", {}), devices, NOW)).toBe("left on Windows 12 min ago");
    expect(describeHandoff(handoff("a", { sourceDeviceId: "zzz" as Handoff["sourceDeviceId"] }), devices, NOW)).toBe("left on another device 12 min ago");
  });

  it("builds handoff.create payloads from the focus", () => {
    const p = handoffPayload("win", { targetDeviceId: "droid", focus: { type: "document", id: "doc-1" }, commandHistory: ["find eric"] });
    expect(p).toMatchObject({ sourceDeviceId: "win", targetDeviceId: "droid", documentId: "doc-1", threadId: null, focus: { type: "document", id: "doc-1" }, commandHistory: ["find eric"], conclusions: [] });
    expect(handoffPayload("win", { targetDeviceId: null, focus: { type: "thread", id: "t1" } }).threadId).toBe("t1");
  });
});
