/**
 * @system mcp-infrastructure
 * @status handwritten
 */

/**
 * Best-effort parse stringified-JSON string values supplied for Json columns.
 *
 * Prisma serializes a JS *string* sent for a Json column as a jsonb string
 * scalar (it does NOT parse the string's content as JSON) — so an AI sending
 * `values: "[]"` stores `'"[]"'`, whose `jsonb_typeof` is `'string'`, tripping
 * CHECK constraints that require an array/object and silently corrupting
 * arbitrary Json columns. The tool schema types every Json column as
 * `type:"object"`, so agents frequently send stringified JSON guessing at the
 * shape. Parsing those strings into real JS values makes every Json column
 * accept the agent's input regardless of how it was serialized; non-Json fields
 * and non-string values are untouched, and a string that is not valid JSON
 * (a legitimate jsonb string scalar) is left as-is.
 */

import {
	getJsonFieldNames,
	isNumericField,
	modelHasField,
} from "@teamscala/tool-executor-substrate/lib/prisma-meta.ts";
import { applyFilterTransform } from "../lib/filter-transform";
import { injectScopeFilter } from "@teamscala/tool-executor-scope/lib/scope.ts";
import type { ExecutionContext, OrpcExecutorConfig } from "@teamscala/tool-executor-substrate/lib/types.ts";
import {
	extractFlatFilters,
	liftRemainingColumnFilters,
	RESERVED_INPUT_KEYS,
} from "./orpc-args-where.ts";

/**
 * Context protection limits — prevent AI agents from blowing up their context window.
 *
 * MAX_TAKE: Hard cap on rows returned per request. Callers requesting more get capped.
 * DEFAULT_LIMIT: Fallback when neither input.take nor config.defaultLimit is set.
 */
const MAX_TAKE = 200;
const DEFAULT_LIMIT = 20;

function coerceJsonStringValues(
	data: Record<string, unknown>,
	modelName?: string,
): void {
	if (!modelName) return;
	const jsonFields = getJsonFieldNames(modelName);
	if (jsonFields.size === 0) return;
	for (const key of Object.keys(data)) {
		if (!jsonFields.has(key)) continue;
		if (typeof data[key] !== "string") continue;
		try {
			data[key] = JSON.parse(data[key] as string);
		} catch {
			// Not valid JSON — leave it; the column may legitimately hold this string.
		}
	}
}

export function buildFindManyArgs(
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
	modelName?: string,
): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const where: Record<string, unknown> =
		(input.where as Record<string, unknown>) || {};

	// NOTE: "search" param is handled centrally in the RAG pre-processing block
	// (lines 71-108) BEFORE this function is called. By the time we get here,
	// cleanArgs.search has already been processed and deleted.

	// 1. Extract flat filter fields from top-level input into where
	//     Coerce numbers to strings — Prisma String fields reject raw numbers
	//     (e.g. telegram_chat_id sent as 1887789588 instead of "1887789588")
	//     searchFields use CONTAINS (read path — partial match) per extractFlatFilters.
	extractFlatFilters(input, where, config, { searchFieldMode: "contains" });

	liftRemainingColumnFilters(input, where, modelName);

	// 2. Apply filter transforms (AI-friendly params → Prisma operators)
	if (config.filterTransforms) {
		for (const [aiParam, transform] of Object.entries(
			config.filterTransforms,
		)) {
			if (input[aiParam] !== undefined) {
				applyFilterTransform(where, transform, input[aiParam]);
			}
		}
	}

	// 3. Inject scope filter
	injectScopeFilter(where, config, context, modelName);

	// 4. Inject autoInject.findMany into where
	if (config.autoInject?.findMany) {
		Object.assign(where, config.autoInject.findMany);
	}

	args.where = where;

	// 5. Set take with context protection:
	//    - Clamp input.take to MAX_TAKE (prevent unbounded requests)
	//    - Fall back to config.defaultLimit if no input
	//    - Fall back to DEFAULT_LIMIT if no config (global safety net)
	if (input.take !== undefined) {
		const requestedTake = Number(input.take);
		args.take = Number.isFinite(requestedTake)
			? Math.min(requestedTake, MAX_TAKE)
			: DEFAULT_LIMIT;
	} else if (config.defaultLimit !== undefined) {
		args.take = Math.min(config.defaultLimit, MAX_TAKE);
	} else {
		args.take = DEFAULT_LIMIT;
	}

	// 6. Set orderBy from input or config defaultOrderBy
	if (input.orderBy) {
		args.orderBy = input.orderBy;
	} else if (config.defaultOrderBy) {
		args.orderBy = [config.defaultOrderBy];
	}
	// If neither is set, no orderBy — Prisma uses default (insertion order)

	// 7. Pass through skip
	if (input.skip !== undefined) args.skip = input.skip;

	// 8. Build select from fields array (mandatory — enforced by caller)
	//    fields: ["id", "name", "status"] → select: { id: true, name: true, status: true }
	if (input.fields && Array.isArray(input.fields) && input.fields.length > 0) {
		const select: Record<string, boolean> = {};
		for (const f of input.fields as string[]) {
			select[f] = true;
		}
		// Always include Prisma identity fields even if caller forgot. A
		// composite @@id/@@unique is one identity, not an invented `id`.
		const keyFields = config.identifierFields?.length
			? config.identifierFields
			: [config.identifierField || config.idField || "id"];
		for (const keyField of keyFields) select[keyField] = true;
		args.select = select;
	} else if (input.select !== undefined) {
		args.select = input.select;
	} else if (config.defaultSelect) {
		args.select = config.defaultSelect;
	}
	if (input.include !== undefined) args.include = input.include;

	return args;
}

/**
 * An organisation identity that is still an env-var TEMPLATE is a caller
 * whose launch env lacked the variable (e.g. ${MCP_SYSTEM_ORG_ID} sent
 * literally by a CLI that never expanded it). It must fail LOUDLY here —
 * the one boundary a write crosses — never persist as a row value and
 * never silently filter reads to zero rows. Measured 2026-08-31: the
 * literal reached a work_items.create invocation verbatim.
 */
const UNEXPANDED_TEMPLATE_RE = /\$\{\w+\}/;

export function organisationValueOrRefuse(
	value: string | null | undefined,
	source: string,
): string | undefined {
	if (!value) return undefined;
	if (UNEXPANDED_TEMPLATE_RE.test(value)) {
		throw new Error(
			`Refusing write: the caller's organisation identity is an unexpanded env template '${value}' ` +
				`(from ${source}). The CLI that sent this request was launched without that variable set — ` +
				"restart the lane from a launcher that supplies its organisation identity, or fix the " +
				"MCP profile's org header template.",
		);
	}
	return value;
}

export function buildCreateData(
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
	modelName?: string,
): Record<string, unknown> {
	// If input already has {data: ...}, use it; otherwise treat input as data
	const data: Record<string, unknown> = input.data
		? { ...(input.data as Record<string, unknown>) }
		: { ...input };

	// Inject org scope field for data isolation (security-critical)
	// Skip injection for models that inherit org through relations (e.g. projects → initiatives)
	// Admin mode: allow passing organisation_id directly, or inject from context if available
	if (!config.skipOrgInjectOnCreate && config.scopeType !== "public") {
		const orgField = config.orgField || "organisation_id";
		// Only inject if the model actually has this field.
		// Some models (e.g. projects, tasks) don't have organisation_id directly
		// and inherit org scope through relations.
		const modelHasOrgField = modelName
			? modelHasField(modelName, orgField)
			: true;
		// A caller-supplied org that is still an unexpanded template is refused
		// outright — same defect, same loud failure.
		if (modelHasOrgField && typeof data[orgField] === "string") {
			organisationValueOrRefuse(data[orgField] as string, "caller input");
		}
		// Preserve existing value from input, inject from context only if missing
		if (modelHasOrgField && !data[orgField]) {
			const injected = organisationValueOrRefuse(
				context.organisationId,
				"caller context",
			);
			if (injected) data[orgField] = injected;
		}
	}

	// Apply autoInject.create — this is how tools declare which extra fields
	// to inject (user_id, created_by, etc). Nothing is assumed about column existence.
	if (config.autoInject?.create) {
		for (const [k, v] of Object.entries(config.autoInject.create)) {
			// Special value "$userId" resolves to context.userId at runtime
			if (v === "$userId" && context.userId) {
				data[k] = data[k] ?? context.userId;
			} else {
				data[k] = data[k] ?? v;
			}
		}
	}

	// Coerce stringified-JSON strings supplied for Json columns into real values
	// (see coerceJsonStringValues). Applies to every Json column on this model.
	coerceJsonStringValues(data, modelName);

	return { data };
}

export function buildUpdateArgs(
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
	modelName?: string,
): Record<string, unknown> {
	let where: Record<string, unknown>;
	let data: Record<string, unknown>;

	const idField = config.identifierField || "id";
	const keyFields = config.identifierFields?.length
		? config.identifierFields
		: [idField];
	const hasFlatIdentity = keyFields.every((field) => input[field] !== undefined);
	if (config.autoTransformUpdate && hasFlatIdentity && !input.where) {
		// Transform flat {id, ...fields} → {where: {id}, data: {...}}
		const rest = { ...input };
		where = {};
		for (const field of keyFields) {
			where[field] = rest[field];
			delete rest[field];
		}
		// If rest contains a pre-wrapped 'data' object, use it directly.
		// Consolidated tools (action-based) send { id, data: { status: "..." } }
		// — spreading rest would create data.data (double-nested), breaking Prisma.
		if (
			rest.data &&
			typeof rest.data === "object" &&
			!Array.isArray(rest.data)
		) {
			data = { ...(rest.data as Record<string, unknown>) };
		} else {
			data = { ...rest };
		}
	} else {
		where = (input.where as Record<string, unknown>) || {};
		data = (input.data as Record<string, unknown>) || {};
		// Consolidated tools often pass filters top-level for update_many.
		// Lift known flat filter fields into where.
		extractFlatFilters(input, where, config);

		// If update_many data isn't wrapped in input.data, infer it from remaining top-level fields.
		if (!input.data) {
			const inferredData: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(input)) {
				if (RESERVED_INPUT_KEYS.has(k)) continue;
				if (keyFields.includes(k)) continue;
				if (config.flatFilterFields?.includes(k)) continue;
				// searchFields are lifted into `where` by extractFlatFilters above —
				// drop them here so a writable searchable field (e.g. `title`) is not
				// double-used as both filter and data on update_many.
				if (config.searchFields?.includes(k)) continue;
				inferredData[k] = v;
			}
			data = inferredData;
		}
	}

	// An identity field inside `data` is a row ADDRESS mistaken for a
	// settable value. Measured 2026-08-20 via the builda_pages generated tool:
	// {action:"update", data:{puck_data, id}} fell through to where:{} (org
	// scope only), failed at Prisma with a foreign echo, and carried data.id
	// as an attempted PRIMARY-KEY write. The caller meant to address the row —
	// refuse naming the two shapes that work (`friction-is-a-stop-condition`).
	for (const field of keyFields) {
		if (data[field] !== undefined) {
			throw new Error(
				`"${field}" is an identity field (a row address), not a settable value — it cannot go inside \`data\`. ` +
					`Pass it top-level ({action:"update", ${field}: "…", data:{…}}) or inside \`where\` ({where:{${field}:"…"}, data:{…}}).`,
			);
		}
	}

	// Coerce numeric values to strings for fields that Prisma expects as String
	// (e.g. telegram_chat_id sent as 8515867758 instead of "8515867758")
	for (const [k, v] of Object.entries(data)) {
		if (
			typeof v === "number" &&
			(!modelName || !isNumericField(modelName, k))
		) {
			data[k] = String(v);
		}
	}

	// Coerce stringified-JSON strings supplied for Json columns into real values
	// (see coerceJsonStringValues). Applies to every Json column on this model.
	coerceJsonStringValues(data, modelName);

	// Inject scope into where
	injectScopeFilter(where, config, context, modelName);

	// Apply autoInject.update — this is how tools declare which extra fields
	// to inject (updated_by, etc). Skip fields that don't exist on the model.
	if (config.autoInject?.update) {
		for (const [k, v] of Object.entries(config.autoInject.update)) {
			if (modelName && !modelHasField(modelName, k)) continue;
			if (v === "$userId" && context.userId) {
				data[k] = data[k] ?? context.userId;
			} else {
				data[k] = data[k] ?? v;
			}
		}
	}

	return { where, data };
}
