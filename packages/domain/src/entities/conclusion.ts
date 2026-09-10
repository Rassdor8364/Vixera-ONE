import type { ConclusionId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";
import type { EntityRef } from "../graph/relationship.ts";

/**
 * A Vixera conclusion about an entity ("7.1 now covers contractors — would
 * include Eric's work"). Produced by rules today, by models later. Carried in
 * handoffs so the receiving device knows what Vixera already understood.
 */
export interface Conclusion extends UserScoped {
  readonly id: ConclusionId;
  readonly userId: UserId;
  readonly subject: EntityRef;
  readonly text: string;
  /** `rule:<name>` or `model:<provider>/<model>`. */
  readonly producedBy: string;
  readonly confidence: number;
  readonly metadata: JsonObject;
  readonly createdAt: IsoDateTime;
}
