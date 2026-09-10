import { newId, type RelationshipId, type UserId } from "../ids.ts";
import {
  edgeKey,
  refKey,
  type EntityRef,
  type EntityType,
  type Relationship,
  type RelationshipInput,
  type RelationshipKind,
} from "./relationship.ts";

export interface NeighborQuery {
  readonly kind?: RelationshipKind;
  readonly type?: EntityType;
  /** "out": edges where the node is `from`; "in": node is `to`; "both" (default). */
  readonly direction?: "out" | "in" | "both";
}

export interface Neighbor {
  readonly ref: EntityRef;
  readonly edge: Relationship;
  readonly direction: "out" | "in";
}

/**
 * In-memory context graph over typed relationships. Used by the linker
 * (to reason about a batch before persisting), by NOW derivation and by
 * tests. The persistent graph is the `relationships` table; this class is a
 * faithful, dependency-free model of its semantics (dedupe by natural key,
 * user scoping, typed neighbors).
 */
export class ContextGraph {
  private readonly edges = new Map<string, Relationship>();
  private readonly byNode = new Map<string, Set<string>>();

  constructor(
    readonly userId: UserId,
    initial: Iterable<Relationship> = [],
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    for (const e of initial) this.load(e);
  }

  get size(): number {
    return this.edges.size;
  }

  /** Adds an edge; returns the existing edge if the same fact is already present. */
  relate(input: RelationshipInput): Relationship {
    if (input.from.type === input.to.type && input.from.id === input.to.id) {
      throw new Error("An entity cannot relate to itself");
    }
    const key = edgeKey(input);
    const existing = this.edges.get(key);
    if (existing) return existing;
    const edge: Relationship = {
      id: newId<RelationshipId>(),
      userId: this.userId,
      from: input.from,
      kind: input.kind,
      to: input.to,
      confidence: clamp01(input.confidence ?? 1),
      source: input.source ?? "user",
      metadata: input.metadata ?? {},
      createdAt: this.clock(),
    };
    this.load(edge);
    return edge;
  }

  unrelate(input: Pick<Relationship, "from" | "kind" | "to">): boolean {
    const key = edgeKey(input);
    const edge = this.edges.get(key);
    if (!edge) return false;
    this.edges.delete(key);
    this.byNode.get(refKey(edge.from))?.delete(key);
    this.byNode.get(refKey(edge.to))?.delete(key);
    return true;
  }

  has(input: Pick<Relationship, "from" | "kind" | "to">): boolean {
    return this.edges.has(edgeKey(input));
  }

  /** Removes every edge touching the entity (mirrors the DB delete trigger). */
  removeEntity(node: EntityRef): number {
    const keys = [...(this.byNode.get(refKey(node)) ?? [])];
    for (const k of keys) {
      const e = this.edges.get(k);
      if (e) this.unrelate(e);
    }
    return keys.length;
  }

  neighbors(node: EntityRef, query: NeighborQuery = {}): Neighbor[] {
    const direction = query.direction ?? "both";
    const out: Neighbor[] = [];
    for (const key of this.byNode.get(refKey(node)) ?? []) {
      const edge = this.edges.get(key);
      if (!edge) continue;
      if (query.kind && edge.kind !== query.kind) continue;
      const isOut = refKey(edge.from) === refKey(node);
      if (direction === "out" && !isOut) continue;
      if (direction === "in" && isOut) continue;
      const other = isOut ? edge.to : edge.from;
      if (query.type && other.type !== query.type) continue;
      out.push({ ref: other, edge, direction: isOut ? "out" : "in" });
    }
    return out;
  }

  /** Convenience: neighbor refs of a given type, regardless of edge kind or direction. */
  related(node: EntityRef, type: EntityType): EntityRef[] {
    const seen = new Set<string>();
    const result: EntityRef[] = [];
    for (const n of this.neighbors(node, { type })) {
      const k = refKey(n.ref);
      if (seen.has(k)) continue;
      seen.add(k);
      result.push(n.ref);
    }
    return result;
  }

  /** Breadth-first: every entity reachable within `depth` hops. */
  reachable(node: EntityRef, depth: number, type?: EntityType): EntityRef[] {
    const seen = new Set<string>([refKey(node)]);
    let frontier: EntityRef[] = [node];
    const found: EntityRef[] = [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: EntityRef[] = [];
      for (const n of frontier) {
        for (const nb of this.neighbors(n)) {
          const k = refKey(nb.ref);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(nb.ref);
          if (!type || nb.ref.type === type) found.push(nb.ref);
        }
      }
      frontier = next;
    }
    return found;
  }

  all(): Relationship[] {
    return [...this.edges.values()];
  }

  private load(edge: Relationship): void {
    if (edge.userId !== this.userId) {
      throw new Error(`Relationship ${edge.id} belongs to another user`);
    }
    const key = edgeKey(edge);
    this.edges.set(key, edge);
    for (const node of [edge.from, edge.to]) {
      const nk = refKey(node);
      let set = this.byNode.get(nk);
      if (!set) {
        set = new Set();
        this.byNode.set(nk, set);
      }
      set.add(key);
    }
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
