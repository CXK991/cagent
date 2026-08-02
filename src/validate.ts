// Minimal JSON-Schema argument validation for tool calls.
// Supports the subset our tool schemas use: type, required, properties,
// enum, minimum. On failure the caller feeds ToolArgError back to the model.

type Schema = Record<string, unknown>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // object | string | number | boolean | undefined | function
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function validateValue(value: unknown, schema: Schema, path: string): string | null {
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    return `${path}: expected ${type}, got ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path}: must be one of ${JSON.stringify(schema.enum)}`;
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    return `${path}: must be >= ${schema.minimum}`;
  }
  if (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) return `${path}: missing required property '${key}'`;
    }
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) {
        const err = validateValue(obj[key], subSchema, path ? `${path}.${key}` : key);
        if (err) return err;
      }
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i++) {
      const err = validateValue(value[i], schema.items as Schema, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/** Validate tool-call arguments against the tool's JSON Schema. */
export function validateArgs(args: Record<string, unknown>, parameters: Schema): ValidationResult {
  const err = validateValue(args, parameters, "");
  return err ? { ok: false, error: err } : { ok: true };
}
