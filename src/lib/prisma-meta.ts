/**
 * @system mcp-infrastructure
 * @status handwritten
 */

/**
 * Build a cache of model name → field meta from the injected Prisma client's
 * runtime datamodel.
 *
 * tool-executor is a configured primitive: the Prisma client arrives via
 * `getPrisma()` injection and is never imported (configured-primitives /
 * one-db-surface). Prisma 7 carries the parsed datamodel on the client instance
 * as `_runtimeDataModel.models` (keyed by model name); the static `Prisma.dmmf`
 * namespace is no longer exported in v7. Referencing a bare `Prisma` value here
 * threw `ReferenceError: Prisma is not defined` on every ORPC action.
 *
 * Each DMMF field carries `type` (the scalar type name, e.g. "Json", "String")
 * and `kind` ("scalar" | "object" | "enum"); a Json column is `kind:"scalar",
 * type:"Json"`. We cache both so callers can ask "which fields are Json?" — the
 * ORPC arg builder needs this to coerce stringified-JSON inputs (see orpc-args).
 */

/**
 * Get the names of a model's Json columns (Prisma scalar fields of type "Json").
 *
 * The ORPC arg builder parses stringified-JSON string values for these fields:
 * Prisma serializes a JS *string* sent for a Json column as a jsonb string
 * scalar (not parsed JSON), so an AI sending `values: "[]"` would otherwise
 * store `'"[]"'` and trip CHECK constraints requiring an array/object. Knowing
 * which fields are Json makes that coercion apply to every Json column, never
 * a non-Json one.
 *
 * @param modelName - The Prisma model name
 * @returns Set of Json field names, or empty Set if model not found
 */

import { createCache } from "@teamscala/cache/create-cache";
import { getPrisma } from "../configure.ts";

/** Cached map of model name → field name → DMMF field meta (type/kind). */
type FieldMeta = { type: string; kind: string };
// The client instance rides IN the cached entry: configure() can rebind the
// provider (boot, tests in a shared process); if the client identity changes,
// the cache is rebuilt so it never serves a stale datamodel.
const modelFieldsCache = createCache<{ client: unknown; fields: Map<string, Map<string, FieldMeta>> }>(
	"tool-executor:prisma-model-fields",
	{ ttlMs: Number.POSITIVE_INFINITY, maxSize: 1 },
);

/**
 * Return the cache, rebuilding it iff it is empty or the injected Prisma client
 * has been swapped out from under us (configure() rebind at boot, or a test
 * re-configuring in a shared process).
 */
function fieldsCache(): Map<string, Map<string, FieldMeta>> {
	const client = getPrisma();
	const hit = modelFieldsCache.get("default");
	if (hit && hit.client === client) return hit.fields;
	const fields = buildModelFieldsCache(client);
	modelFieldsCache.set("default", { client, fields });
	return fields;
}

function buildModelFieldsCache(
	client: unknown,
): Map<string, Map<string, FieldMeta>> {
	const cache = new Map<string, Map<string, FieldMeta>>();
	const datamodel = (client as {
		_runtimeDataModel?: {
			models?: Record<
				string,
				{ fields?: { name: string; type?: string; kind?: string }[] }
			>;
		};
	} | null)?._runtimeDataModel?.models ?? {};

	for (const [modelName, model] of Object.entries(datamodel)) {
		const fields = new Map<string, FieldMeta>();
		for (const f of model?.fields ?? []) {
			// Relation/object fields reuse the related model name as `type` and
			// carry kind:"object"; only scalars matter for column-level checks.
			fields.set(f.name, {
				type: f.type ?? "",
				kind: f.kind ?? "scalar",
			});
		}
		cache.set(modelName, fields);
	}

	return cache;
}

/**
 * Check if a Prisma model has a specific field.
 *
 * @param modelName - The Prisma model name (e.g., "projects", "tasks")
 * @param fieldName - The field name to check (e.g., "organisation_id")
 * @returns true if the model has the field, false otherwise
 */
export function modelHasField(modelName: string, fieldName: string): boolean {
	const fields = fieldsCache().get(modelName);
	return fields?.has(fieldName) ?? false;
}

/**
 * Get all field names for a model.
 *
 * @param modelName - The Prisma model name
 * @returns Set of field names, or empty Set if model not found
 */
export function getModelFields(modelName: string): Set<string> {
	const fields = fieldsCache().get(modelName);
	return fields ? new Set(fields.keys()) : new Set();
}

export function getJsonFieldNames(modelName: string): Set<string> {
	const fields = fieldsCache().get(modelName);
	if (!fields) return new Set();
	const jsonFields = new Set<string>();
	for (const [name, meta] of fields) {
		if (meta.kind === "scalar" && meta.type === "Json") {
			jsonFields.add(name);
		}
	}
	return jsonFields;
}

/** Whether a model field is a numeric Prisma scalar. */
export function isNumericField(modelName: string, fieldName: string): boolean {
	const meta = fieldsCache().get(modelName)?.get(fieldName);
	return (
		meta?.kind === "scalar" &&
		(meta.type === "Int" ||
			meta.type === "BigInt" ||
			meta.type === "Float" ||
			meta.type === "Decimal")
	);
}
