/**
 * Translate the Anthropic-style JSON Schema we use for tool input into
 * the OpenAPI 3.0 subset Gemini's functionDeclarations expect.
 *
 * Differences:
 *  - Gemini uses `nullable: true` instead of `type: ["X", "null"]`.
 *  - Gemini ignores `pattern` (Zod re-validates on the way back, so OK).
 *  - Gemini doesn't accept `additionalProperties` on function parameters.
 *  - Gemini integer types use `type: "integer"` (same as JSON Schema, fine).
 */
type AnyObj = Record<string, unknown>;

export function jsonSchemaToGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as AnyObj;
  const out: AnyObj = {};

  // type — possibly a union with "null"
  if (Array.isArray(s.type)) {
    const types = s.type as string[];
    const nonNull = types.filter((t) => t !== "null");
    if (types.includes("null")) out.nullable = true;
    out.type = nonNull.length === 1 ? nonNull[0] : nonNull[0]; // pick the first non-null
  } else if (typeof s.type === "string") {
    out.type = s.type;
  }

  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (Array.isArray(s.required)) out.required = s.required;

  // Recurse into properties / items.
  if (s.properties && typeof s.properties === "object") {
    const props: AnyObj = {};
    for (const [k, v] of Object.entries(s.properties as AnyObj)) {
      props[k] = jsonSchemaToGeminiSchema(v);
    }
    out.properties = props;
  }
  if (s.items) out.items = jsonSchemaToGeminiSchema(s.items);

  // Numeric/string range hints — Gemini accepts these.
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (s[k] !== undefined) out[k] = s[k];
  }

  // Drop: additionalProperties, pattern (silently), $schema, $id, title.
  return out;
}
