/**
 * @system mcp-infrastructure
 * @status handwritten
 */
import { getModelFields } from "../lib/prisma-meta";
import { setNestedField } from "../lib/scope";
import type { OrpcExecutorConfig } from "../lib/types";

const RESERVED_INPUT_KEYS = new Set([
	"action",
	"model",
	"fields",
	"take",
	"skip",
	"orderBy",
	"search",
	"targetUserId",
	"where",
	"data",
	"select",
	"include",
]);

/**
 * Lift undeclared top-level parameters that are real model columns into a
 * Prisma where clause. Generated tools expose writable scalar columns in their
 * input schema even when those columns are not part of the small curated
 * flat/search field sets. Read operations must therefore preserve those
 * explicit filters instead of returning a plausible but unrelated first row.
 */
export function liftRemainingColumnFilters(
	input: Record<string, unknown>,
	where: Record<string, unknown>,
	modelName?: string,
	mode: "contains" | "eq" = "contains",
): void {
	if (!modelName) return;
	const known = getModelFields(modelName);
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (RESERVED_INPUT_KEYS.has(key)) continue;
		if (where[key] !== undefined) continue;
		if (known.size > 0 && !known.has(key)) continue;
		where[key] =
			mode === "contains" && typeof value === "string"
				? { contains: value, mode: "insensitive" }
				: value;
	}
}

export function extractFlatFilters(
	input: Record<string, unknown>,
	where: Record<string, unknown>,
	config: OrpcExecutorConfig,
	options: { searchFieldMode?: "eq" | "contains" } = {},
): void {
	// Always extract organisation_id from input if present — this allows callers to override
	// session org context by explicitly passing organisation_id in the input.
	// This must happen before injectScopeFilter runs, so injectScopeFilter sees it and
	// skips session org injection when organisation_id is explicitly provided.
	if (input.organisation_id !== undefined) {
		const orgField = config.orgField || "organisation_id";
		if (orgField.includes(".") && orgField.endsWith(".organisation_id")) {
			setNestedField(where, orgField, input.organisation_id);
		} else {
			where[orgField] = input.organisation_id;
		}
	}

	// flatFilterFields → exact eq (identifiers/enums: id, status, …). Numbers coerced
	// to strings for Prisma String columns (e.g. telegram_chat_id sent as a number).
	// The two always-reserved keys are skipped via the shared reserved set.
	for (const field of config.flatFilterFields ?? []) {
		if (RESERVED_INPUT_KEYS.has(field)) continue;
		if (input[field] === undefined) continue;
		// When orgField is a dotted relation path (e.g. "product_categories.organisation_id"),
		// redirect organisation_id through the relation instead of filtering on the direct column.
		if (
			field === "organisation_id" &&
			config.orgField?.includes(".") &&
			config.orgField.endsWith(".organisation_id")
		) {
			setNestedField(where, config.orgField, input[field]);
			continue;
		}
		where[field] =
			typeof input[field] === "number" ? String(input[field]) : input[field];
	}

	// searchFields → case-insensitive CONTAINS on READS (the "Searchable by"
	// partial-match semantic — consistent with the `search` param's contains
	// behavior, so list{title:'Streaming-Indicator'} finds the task titled
	// 'Streaming-Indicator: …'); eq on WRITES (updateMany/deleteMany), where an
	// exact match is the safer default for destructive bulk ops. A field that
	// appears in BOTH sets keeps the eq set above (where[field] already defined).
	const searchFieldMode = options.searchFieldMode ?? "eq";
	for (const field of config.searchFields ?? []) {
		if (RESERVED_INPUT_KEYS.has(field)) continue;
		if (where[field] !== undefined) continue;
		if (input[field] === undefined) continue;
		const v = input[field];
		if (searchFieldMode === "contains" && typeof v === "string") {
			where[field] = { contains: v, mode: "insensitive" };
		} else {
			where[field] = typeof v === "number" ? String(v) : v;
		}
	}
}

/** Exported for the sibling builders in orpc-args.ts, which share the same
 * reserved-key rule when inferring set-values from flat input. */
export { RESERVED_INPUT_KEYS };
