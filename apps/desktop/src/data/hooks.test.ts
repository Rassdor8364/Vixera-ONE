/**
 * The mail → sender resolution NOW depends on: a `mail.received` item focuses a
 * `mail_message`, `areaForEntity` sends it to People, and the People area has
 * to turn it into a person. Mail is context inside People; there is no mail
 * client in Vixera, so a message that resolves to nobody must say so rather
 * than render an empty pane.
 */
import { describe, expect, it } from "vitest";
import { DEV_USER_ID, ref } from "@vixera/domain";
import { InMemorySpineStore } from "@vixera/sync";

async function seed() {
  const store = new InMemorySpineStore(DEV_USER_ID);
  const account = await store.createConnectorAccount({
    provider: "mock",
    externalAccountId: "acct-1",
    label: "Mock",
    address: "me@example.com",
    capabilities: ["mail"],
    status: "active",
    credentialLocation: "none",
    credentialRef: null,
    lastError: null,
    metadata: {},
  });
  const eric = await store.upsertPerson({
    displayName: "Eric Lindqvist",
    primaryEmail: "eric@lindqvist.example",
    organization: null,
    notes: null,
    metadata: {},
  });
  const base = {
    externalThreadId: null,
    snippet: null,
    bodyText: null,
    to: [],
    cc: [],
    sentAt: null,
    isUnread: true,
    attachments: [],
    labels: [],
  };
  await store.upsertMailMessages(account.id, [
    {
      ...base,
      externalId: "m-1",
      subject: "Invoice",
      from: { email: "eric@lindqvist.example", name: "Eric Lindqvist" },
      receivedAt: "2026-09-08T10:00:00Z",
      fromPersonId: eric.id,
    },
    { ...base, externalId: "m-2", subject: "No sender", from: null, receivedAt: "2026-09-08T11:00:00Z", isUnread: false },
  ]);
  const linked = await store.findMailMessageByExternalId(account.id, "m-1");
  const orphan = await store.findMailMessageByExternalId(account.id, "m-2");
  return { store, eric, linked: linked!, orphan: orphan! };
}

describe("a focused mail message resolves to a person", () => {
  it("uses the sender recorded on the message", async () => {
    const { store, eric, linked } = await seed();
    const message = await store.getMailMessage(linked.id);
    expect(message?.from?.personId).toBe(eric.id);
  });

  it("falls back to the graph when the row carries no sender person", async () => {
    const { store, eric, orphan } = await seed();
    await store.relate({ from: ref("mail_message", orphan.id), kind: "has_person", to: ref("person", eric.id), source: "connector" });
    const neighbors = await store.neighbors(ref("mail_message", orphan.id), { type: "person" });
    expect(neighbors[0]?.ref.id).toBe(eric.id);
  });

  it("resolves to nobody when neither exists", async () => {
    const { store, orphan } = await seed();
    const message = await store.getMailMessage(orphan.id);
    expect(message?.from?.personId ?? null).toBeNull();
    expect(await store.neighbors(ref("mail_message", orphan.id), { type: "person" })).toHaveLength(0);
  });
});
