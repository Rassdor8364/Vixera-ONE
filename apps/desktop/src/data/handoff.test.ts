import { describe, expect, it } from "vitest";
import { DEV_USER_ID, type Device, type Handoff } from "@vixera/domain";
import { acceptHandoff, createHandoff, describeHandoff, handoffPayload, pendingHandoffsFor, selectHandoffTargets } from "./handoff.ts";

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

describe("handoff carries page state and survives an unopenable artifact", () => {
  const doc = {
    id: "44444444-4444-4444-8444-444444444001",
    title: "Operating agreement v3.pdf",
    praxionDocumentId: "praxion-doc-1",
    location: { kind: "device_path" as const, deviceId: "win", path: "C:/docs/agreement.pdf" },
  };

  function screenContextWith(praxionDocumentId: string | null, page: number) {
    return {
      current: async () => ({
        source: "praxion" as const,
        capturedAt: "2026-09-09T15:00:00Z",
        document: { title: "Operating agreement v3.pdf", externalRef: "C:/docs/agreement.pdf", mimeType: "application/pdf", praxionDocumentId },
        location: { page, position: null, selectionText: "7.1" },
        selection: null,
        structuredContent: null,
        text: null,
        metadata: {},
      }),
    } as never;
  }

  it("attaches Praxion's location when the focused document is the one being handed off", async () => {
    const sent: unknown[] = [];
    await createHandoff(
      {
        deviceId: "win",
        reader: { getDocument: async () => doc } as never,
        dispatch: async (envelope) => {
          sent.push(envelope.payload);
          return { status: "done", result: null, error: null, replayed: false, actionRequestId: "a1" };
        },
        screenContext: screenContextWith("praxion-doc-1", 7),
      },
      { targetDeviceId: "droid", focus: { type: "document", id: doc.id }, documentId: doc.id },
    );
    expect((sent[0] as { praxionLocation: { page: number } }).praxionLocation.page).toBe(7);
  });

  it("does not attach the location of a different document", async () => {
    const sent: unknown[] = [];
    await createHandoff(
      {
        deviceId: "win",
        reader: { getDocument: async () => doc } as never,
        dispatch: async (envelope) => {
          sent.push(envelope.payload);
          return { status: "done", result: null, error: null, replayed: false, actionRequestId: "a1" };
        },
        screenContext: screenContextWith("praxion-other", 3),
      },
      { targetDeviceId: "droid", focus: { type: "document", id: doc.id }, documentId: doc.id },
    );
    expect((sent[0] as { praxionLocation: unknown }).praxionLocation).toBeNull();
  });

  it("keeps the handoff accepted when this device cannot open the artifact", async () => {
    const handoff = {
      id: "55555555-5555-4555-8555-555555555001",
      state: "pending" as const,
      sourceDeviceId: "win",
      targetDeviceId: "droid",
      documentId: doc.id,
      focus: { type: "document" as const, id: doc.id },
      artifactStoragePath: null,
      praxionLocation: null,
      createdAt: "2026-09-09T15:00:00Z",
      expiresAt: null,
    } as never;
    let dispatched = 0;
    const result = await acceptHandoff(
      {
        deviceId: "droid",
        reader: { getDocument: async () => doc } as never,
        dispatch: async () => {
          dispatched++;
          return { status: "done", result: null, error: null, replayed: false, actionRequestId: "a2" };
        },
        praxion: { availability: async () => ({ state: "unavailable" as const, reason: "not_running" as const, detail: null }) } as never,
        storage: { signedUrl: async () => { throw new Error("no artifact in storage"); } } as never,
      },
      handoff,
    );
    expect(dispatched).toBe(1);
    expect(result.opened).toBeNull();
    expect(result.openError).toBeTruthy();
  });
});
