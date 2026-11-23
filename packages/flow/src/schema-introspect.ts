import type { ZodType, ZodTypeAny } from "zod";

type Def = { typeName: string; shape?: () => Record<string, ZodTypeAny>; innerType?: ZodTypeAny; type?: ZodTypeAny };

function def(s: ZodTypeAny): Def {
  return (s as unknown as { _def: Def })._def;
}

/** Strip Optional/Nullable/Default/Effects wrappers to reach the underlying type. */
export function unwrap(s: ZodTypeAny): ZodTypeAny {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const d = def(cur);
    if (
      d.typeName === "ZodOptional" ||
      d.typeName === "ZodNullable" ||
      d.typeName === "ZodDefault" ||
      d.typeName === "ZodReadonly"
    ) {
      cur = d.innerType as ZodTypeAny;
    } else if (d.typeName === "ZodEffects") {
      cur = (d as unknown as { schema: ZodTypeAny }).schema;
    } else {
      return cur;
    }
  }
  return cur;
}

export function isPermissive(s: ZodTypeAny): boolean {
  const t = def(unwrap(s)).typeName;
  return t === "ZodAny" || t === "ZodUnknown" || t === "ZodRecord";
}

export function objectShape(s: ZodTypeAny): Record<string, ZodTypeAny> | null {
  const u = unwrap(s);
  const d = def(u);
  if (d.typeName !== "ZodObject" || !d.shape) return null;
  return d.shape();
}

export function isOptional(s: ZodTypeAny): boolean {
  return (s as unknown as { isOptional?: () => boolean }).isOptional?.() ?? false;
}

/** Keys a consumer must be given. Used to validate input mappings before a flow is saved. */
export function requiredKeys(s: ZodType): string[] {
  const shape = objectShape(s as ZodTypeAny);
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([, v]) => !isOptional(v))
    .map(([k]) => k);
}

export function knownKeys(s: ZodType): string[] | null {
  const shape = objectShape(s as ZodTypeAny);
  return shape ? Object.keys(shape) : null;
}

/**
 * Does `path` plausibly exist in this schema? Returns null for "cannot tell"
 * (arrays, records, any) so the validator only reports problems it is sure about.
 */
export function pathExists(s: ZodType, path: string[]): boolean | null {
  let cur: ZodTypeAny = s as ZodTypeAny;
  for (const key of path) {
    if (isPermissive(cur)) return null;
    const shape = objectShape(cur);
    if (!shape) return null; // array / union / primitive: cannot tell statically
    if (!(key in shape)) return false;
    cur = shape[key];
  }
  return true;
}
