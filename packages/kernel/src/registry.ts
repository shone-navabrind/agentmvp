import type { ZodType } from "zod";
import { InvalidEventPayload, SupersededEventType, UnknownEventType } from "./types.ts";

export type EventDefinition<P = unknown> = {
  type: string;
  schema: ZodType<P>;
  /** When set, this type is historical: it may be read but never written. */
  supersededBy?: string;
  /** Translates this version's payload into the successor's shape. */
  upcast?: (payload: never) => unknown;
};

/**
 * The schema registry. Emitting an unregistered or invalid event is a hard error --
 * including from plugins. Old event versions stay readable forever via upcaster chains,
 * which is what makes the log safe to keep for years.
 */
export class SchemaRegistry {
  #defs = new Map<string, EventDefinition>();

  define<P>(def: EventDefinition<P>): this {
    if (this.#defs.has(def.type)) {
      throw new Error(`Event type "${def.type}" is already defined`);
    }
    if (def.supersededBy && !def.upcast) {
      throw new Error(`"${def.type}" is superseded but provides no upcast()`);
    }
    this.#defs.set(def.type, def as EventDefinition);
    return this;
  }

  has(type: string): boolean {
    return this.#defs.has(type);
  }

  get(type: string): EventDefinition {
    const def = this.#defs.get(type);
    if (!def) throw new UnknownEventType(type);
    return def;
  }

  /** Validate on write. Superseded types are read-only. */
  validateForWrite(type: string, payload: unknown): unknown {
    const def = this.get(type);
    if (def.supersededBy) throw new SupersededEventType(type, def.supersededBy);
    const parsed = def.schema.safeParse(payload);
    if (!parsed.success) throw new InvalidEventPayload(type, parsed.error.issues);
    return parsed.data;
  }

  /** Walk the upcaster chain so readers only ever see the current shape. */
  upcast(type: string, payload: unknown): { type: string; payload: unknown } {
    let curType = type;
    let curPayload = payload;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(curType)) throw new Error(`Upcaster cycle at "${curType}"`);
      seen.add(curType);
      const def = this.get(curType);
      if (!def.supersededBy) return { type: curType, payload: curPayload };
      curPayload = (def.upcast as (p: unknown) => unknown)(curPayload);
      curType = def.supersededBy;
    }
  }
}
