/**
 * @system tool-executor
 * @status handwritten
 */

/** Default row count when the caller doesn't specify `take`. */
/**
 * Apply default limits to a list call's args. Mutates the args object in-place
 * ONLY when the caller omitted `take` or `fields`. Explicit values are never
 * overridden. Returns whether defaults were applied so the postprocessor can
 * add a pagination hint.
 *
 * @param args The raw args from the MCP tool call
 * @param method The ORPC method (e.g., "list", "findMany")
 * @param availableFields Optional: the columns that exist on this model, used
 *   to filter DEFAULT_FIELDS to only valid columns. If not provided, all
 *   DEFAULT_FIELDS are passed through (the DB will ignore unknown columns).
 */

		// No model info: leave `fields` unset rather than guessing.
		//
		// This branch used to inject the whole of DEFAULT_FIELDS on the premise
		// that "the DB ignores unknown columns". That premise is FALSE for
		// Prisma, which validates `select` against the model and REJECTS an
		// unknown key outright — so the guess did not degrade, it guaranteed
		// failure for every model whose identity columns differ from the
		// registry's slug/label/name shape.
		//
		// Measured 2026-08-08: every `work_items` list call failed with
		// "Unknown field `slug` for select statement on model `work_items`",
		// for ANY argument shape — the default is merged when `fields` is
		// absent and merged ON TOP when it is supplied, so no caller could
		// avoid it. work_items is keyed by id/title/kind and has no slug,
		// label or name. It surfaced while an orchestrator was trying to
		// enumerate projects, and it had been unlistable the whole time.
		//
		// Leaving it unset lets the caller's own "fields is required" check
		// raise a message that names the fix, instead of a Prisma validation
		// error that reads like caller error rather than executor error —
		// which is why this survived (`friction-is-a-stop-condition`: the
		// component knew why it failed and reported it as somebody else's
		// fault).

export const DEFAULT_TAKE = 20;

/** Default column projection when the caller doesn't specify `fields`.
 * Filtered to columns that exist on the model at query time. */
export const DEFAULT_FIELDS = [
	"id",
	"slug",
	"label",
	"title",
	"name",
	"status",
	"is_active",
	"created_at",
	"updated_at",
] as const;

export interface DefaultLimitsResult {
	/** The args object (same reference, possibly mutated). */
	args: Record<string, unknown>;
	/** True when a default take was injected (caller didn't specify one). */
	defaultsApplied: boolean;
	/** The default take value that was injected, if any. */
	defaultTake: number | null;
}

export function applyDefaultLimits(
	args: Record<string, unknown>,
	method: string,
	availableFields?: readonly string[],
): DefaultLimitsResult {
	// Only apply to list/findMany operations
	if (method !== "list" && method !== "findMany") {
		return { args, defaultsApplied: false, defaultTake: null };
	}

	let defaultsApplied = false;

	// Default take
	if (args.take === undefined || args.take === null) {
		args.take = DEFAULT_TAKE;
		defaultsApplied = true;
	}

	// Default fields (column projection)
	if (args.fields === undefined || args.fields === null) {
		if (availableFields && availableFields.length > 0) {
			// Filter DEFAULT_FIELDS to only columns that exist on this model
			const available = new Set(availableFields);
			args.fields = DEFAULT_FIELDS.filter((f) => available.has(f));
		}
	}

	return {
		args,
		defaultsApplied,
		defaultTake: defaultsApplied ? DEFAULT_TAKE : null,
	};
}

/**
 * Wrap a findMany result with a pagination hint when default limits were applied.
 * The agent sees exactly how many results exist and how to get more.
 *
 * Only wraps when `defaultsApplied` is true AND the result looks like an array
 * (the ORPC wrapper or a bare array). Does NOT wrap single-object results or
 * results that already have pagination metadata.
 */
export function addPaginationHint(
	result: unknown,
	defaultTake: number,
	totalCount?: number,
): unknown {
	const hint = {
		returned: 0,
		total: totalCount ?? null,
		has_more: totalCount != null ? totalCount > defaultTake : null,
		hint: `Showing first ${defaultTake} results. Pass \`skip\` to paginate, or \`take: 0\` for all.`,
	};

	// ORPC wrapper: { success, data: [...] }
	if (result && typeof result === "object" && "success" in result) {
		const wrapper = result as { success: unknown; data: unknown; _pagination?: unknown };
		if (Array.isArray(wrapper.data)) {
			hint.returned = wrapper.data.length;
			// Don't double-wrap if already paginated
			if (wrapper._pagination) return result;
			return { ...wrapper, _pagination: hint };
		}
		return result;
	}

	// Bare array
	if (Array.isArray(result)) {
		hint.returned = result.length;
		if (result.length === 0) return result;
		return { items: result, _pagination: hint };
	}

	return result;
}
