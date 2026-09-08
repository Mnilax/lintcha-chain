// A small JSON Schema checker written for the launch index: the keywords the schema uses and no others. Any keyword
// it does not know is an error, so the schema cannot carry a constraint that is silently ignored. Returns the list
// of violations as "path: message"; an empty list is a pass.
const KNOWN = new Set(["$schema", "title", "description", "type", "additionalProperties", "minProperties", "maxProperties", "properties", "required", "$defs", "$ref", "propertyNames", "minimum", "maximum", "pattern", "enum", "const"]);

export function validate(schema, value, root = schema, path = "$", out = []) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error("schema keyword not supported by this checker: " + k);
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) throw new Error("only local refs: " + schema.$ref);
    const target = schema.$ref.slice(2).split("/").reduce((o, k) => o && o[k], root);
    if (!target) throw new Error("dangling ref " + schema.$ref);
    return validate(target, value, root, path, out);
  }
  const bad = m => { out.push(path + ": " + m); return out; };
  if (schema.type) {
    const t = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const okType = schema.type === "integer" ? (t === "number" && Number.isInteger(value)) : schema.type === "number" ? t === "number" : schema.type === t;
    if (!okType) return bad("expected " + schema.type + ", got " + t);
  }
  if ("const" in schema && value !== schema.const) return bad("expected " + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(value)) return bad("not one of " + JSON.stringify(schema.enum));
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) bad("below minimum " + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) bad("above maximum " + schema.maximum);
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) bad("does not match " + schema.pattern);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value), props = schema.properties || {};
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) bad("fewer than " + schema.minProperties + " properties");
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) bad("more than " + schema.maxProperties + " properties");
    for (const r of schema.required || []) if (!(r in value)) bad("missing " + r);
    for (const k of keys) {
      const sub = path + "." + k;
      if (schema.propertyNames && schema.propertyNames.pattern && !new RegExp(schema.propertyNames.pattern).test(k)) out.push(sub + ": key does not match " + schema.propertyNames.pattern);
      if (k in props) validate(props[k], value[k], root, sub, out);
      else if (schema.additionalProperties === false) out.push(sub + ": field not allowed");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(schema.additionalProperties, value[k], root, sub, out);
    }
  }
  return out;
}
