import { toJSONSchema, type ZodType } from 'zod';

/**
 * Recursively traverse the JSON Schema to ensure all object types have strict constraints:
 * - additionalProperties: false
 * - Ensure each nested object has a required array (natively guaranteed by zodToJsonSchema)
 */
function ensureStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  // Azure Structured Outputs strict mode rejects these JSON Schema keywords
  // (they appear in z.record() output). Strip them so the schema is accepted.
  delete schema.propertyNames;
  delete schema.patternProperties;
  // Same Azure-compatible detection as makeSchemaOpenAICompatible below.
  const isObjectSchema =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && (schema.type as unknown[]).includes('object'));
  if (isObjectSchema && typeof schema.properties === 'object' && schema.properties) {
    schema.additionalProperties = false;
    for (const key of Object.keys(schema.properties as Record<string, unknown>)) {
      const val = (schema.properties as Record<string, unknown>)[key];
      if (val && typeof val === 'object') {
        (schema.properties as Record<string, unknown>)[key] = ensureStrictJsonSchema(val as Record<string, unknown>);
      }
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    schema.items = ensureStrictJsonSchema(schema.items as Record<string, unknown>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schema.additionalProperties = ensureStrictJsonSchema(schema.additionalProperties as Record<string, unknown>);
  }
  return schema;
}

/**
 * Convert a Zod schema to a JSON Schema (for tool parameters),
 * automatically injecting strict constraints (additionalProperties: false).
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  return ensureStrictJsonSchema(toJSONSchema(schema) as Record<string, unknown>);
}

/**
 * Make a JSON Schema compatible with OpenAI Structured Outputs / strict mode:
 * 1. Add all properties' keys to the required array
 * 2. For fields newly added to required (originally optional), wrap type as {type: [originalType, "null"]}
 *
 * OpenAI strict mode requires: required must include every key of properties.
 */
export function makeSchemaOpenAICompatible(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;

  // Azure strict mode: a schema with `type: ["object", "null"]` is still an
  // object schema at heart — we need to recurse into its `properties` even
  // when type has been wrapped to allow null. Detect "object-ness" with
  // either the string form or an array form that includes "object".
  const isObjectSchema =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && (schema.type as unknown[]).includes('object'));

  if (isObjectSchema && typeof schema.properties === 'object' && schema.properties) {
    const propKeys = Object.keys(schema.properties as Record<string, unknown>);
    const requiredSet = new Set<string>(
      Array.isArray(schema.required) ? (schema.required as string[]) : []
    );

    for (const key of propKeys) {
      if (!requiredSet.has(key)) {
        // This property was optional in Zod — add null acceptance
        const prop = (schema.properties as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
        if (prop && typeof prop === 'object') {
          // Handle z.any() / type-less properties (e.g. changeLog[].from)
          if (!prop.type && !prop.anyOf && !prop.oneOf && !prop.$ref) {
            prop.type = ['string', 'null'];
          } else if (typeof prop.type === 'string') {
            prop.type = [prop.type, 'null'];
          } else if (Array.isArray(prop.type) && !prop.type.includes('null')) {
            prop.type.push('null');
          }
          // anyOf/oneOf: each branch needs null too
          for (const combinator of ['anyOf', 'oneOf'] as const) {
            if (Array.isArray(prop[combinator])) {
              (prop[combinator] as Record<string, unknown>[]).push({ type: 'null' });
            }
          }
        }
        requiredSet.add(key);
      }
    }

    schema.required = Array.from(requiredSet);

    // Recurse into properties
    for (const key of propKeys) {
      const val = (schema.properties as Record<string, unknown>)[key];
      if (val && typeof val === 'object') {
        (schema.properties as Record<string, unknown>)[key] = makeSchemaOpenAICompatible(val as Record<string, unknown>);
      }
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    schema.items = makeSchemaOpenAICompatible(schema.items as Record<string, unknown>);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    schema.additionalProperties = makeSchemaOpenAICompatible(schema.additionalProperties as Record<string, unknown>);
  }

  return schema;
}