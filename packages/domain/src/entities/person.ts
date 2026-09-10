import type { ConnectorAccountId, PersonId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

/**
 * A person in the user's world, normalized across connector sources.
 * One person may have many identities (emails, phones, provider ids).
 */
export interface Person extends UserScoped, Timestamped {
  readonly id: PersonId;
  readonly userId: UserId;
  readonly displayName: string;
  readonly primaryEmail: string | null;
  readonly organization: string | null;
  readonly notes: string | null;
  /** When two people are merged, the loser points to the survivor. */
  readonly mergedIntoId: PersonId | null;
  readonly metadata: JsonObject;
}

export type PersonIdentityKind = "email" | "phone" | "provider";

export interface PersonIdentity extends UserScoped {
  readonly id: string;
  readonly userId: UserId;
  readonly personId: PersonId;
  readonly kind: PersonIdentityKind;
  /** Normalized value (lower-cased email, E.164 phone, `provider:id`). */
  readonly value: string;
  /** Display form as seen at the source, e.g. original-case email. */
  readonly rawValue: string;
  readonly provider: string | null;
  readonly connectorAccountId: ConnectorAccountId | null;
  readonly createdAt: IsoDateTime;
}
