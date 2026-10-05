/**
 * @system mcp-infrastructure
 * @status handwritten
 */

	// `select` is the PRISMA name for a column projection, and this surface calls it `fields`. A caller reaching for `select` is not making a typo — they are
	// using the name the underlying ORM uses, which is the most natural guess available and therefore the one to expect.
	//
	// WHY THIS THROWS INSTEAD OF ALIASING. The key is stripped at the ORPC edge (valibot `object()` drops unknown entries), so it never reaches Prisma and
	// nothing errors. `applyDefaultLimits` then sees `fields` absent, injects the key-column default, and the caller gets a thin, cheerful, WRONG result: the
	// exact columns they asked for are the ones missing, with no signal that their argument was discarded.
	//
	// Measured 2026-08-08: an orchestrator asked `cli_session_messages` for `role` and `message_type` — the two columns that answer "is this lane
	// working" — got back id/created_at/updated_at, concluded the gateway was broken, fell back to screen-scraping tmux, misread five working lanes as
	// idle and interrupted all of them. The tool was fine. It just never said no.
	//
	// Aliasing would fix this call and leave the class open, because the next silently-dropped key gets the same treatment. Refusing NAMES the right path
	// (`friction-is-a-stop-condition`: a block is only finished when it says what to do instead), and it converts a wrong answer into a fixable error.

		// Pass the model's REAL columns so the default projection is filtered to
		// them. `mcp-result-budget` has always specified "filtered to columns
		// that exist on the model"; the helper has always supported it; this
		// call site never supplied them, so nothing was ever filtered and the
		// spec was satisfied only for models that happen to carry the registry's
		// slug/label/name shape. Prisma REJECTS an unknown `select` key rather
		// than ignoring it, so an unfiltered default is not a loose default —
		// it is a hard failure for every other model (`work_items` was
		// unlistable for every caller until 2026-08-08).
		//
		// This is the derivation, not a per-model allow-list: DMMF already
		// knows every model's fields, so no catalogue can drift out of date
		// (`identity-is-imported-never-spelled` — a hand-kept column map is the
		// parallel catalogue to avoid).

import { resolveAdminOverride, validateAuth } from "#tool-executor/lib/auth.ts";
import { applyDefaultLimits } from "#tool-executor/lib/default-limits.ts";
import { getModelFields, modelHasField } from "#tool-executor/lib/prisma-meta.ts";
import type {
	ExecutionContext,
	OrpcExecutorConfig,
} from "#tool-executor/lib/types.ts";
import { rejectForbiddenFieldValues } from "./prepare-args-guard.ts";

export async function prepareArgs(
	args: Record<string, unknown>,
	methodName: string,
	modelName: string,
	context: ExecutionContext,
	config: OrpcExecutorConfig,
) {
	const cleanArgs = { ...args };
	rejectForbiddenFieldValues(cleanArgs, config.forbiddenFieldValues);

	if ("select" in cleanArgs) {
		throw new Error(
			`This surface projects columns with \`fields\`, not \`select\`. ` +
				`Pass \`fields: [...]\` (an array of column names) instead — ` +
				`\`select\` is discarded before it reaches the database, so the ` +
				`columns you asked for come back missing rather than erroring.`,
		);
	}

	// Apply MCP result-budget defaults (take:20, key-column projection) when
	// the caller omitted them on a list/findMany operation. mcp-result-budget.
	// Capture whether defaults were applied so the postprocessor can attach
	// a pagination hint the agent reads.
	let defaultsApplied = false;
	let defaultTake: number | null = null;
	if (methodName === "findMany") {
		const limitsResult = applyDefaultLimits(cleanArgs, methodName, [
			...getModelFields(modelName),
		]);
		defaultsApplied = limitsResult.defaultsApplied;
		defaultTake = limitsResult.defaultTake;
	}

	if (config.passthrough) {
		delete cleanArgs.action;
		return {
			cleanArgs,
			fieldsParam: undefined as string[] | undefined,
			resolvedContext: { ...context },
			overrideUserId: undefined as string | undefined,
			defaultsApplied,
			defaultTake,
		};
	}

	let fieldsParam: string[] | undefined;
	const rawFields = cleanArgs.fields;
	if (Array.isArray(rawFields)) {
		fieldsParam = rawFields.filter((f): f is string => typeof f === "string");
	} else if (typeof rawFields === "string") {
		fieldsParam = rawFields
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
	}
	if (fieldsParam?.some((f) => f.includes("."))) {
		throw new Error(
			`Invalid field name: fields cannot contain dots for nested selection. Use flat fields only.`,
		);
	}
	delete cleanArgs.fields;

	delete cleanArgs.model;

	if (
		(methodName === "findMany" ||
			methodName === "findUnique" ||
			methodName === "findFirst") &&
		(!fieldsParam || !Array.isArray(fieldsParam) || fieldsParam.length === 0) &&
		!config.defaultSelect
	) {
		throw new Error(
			`"fields" parameter is required for ${methodName}. ` +
				`Specify which columns to return, e.g. fields: ["id", "name", "status"].`,
		);
	}

	validateAuth(config.scopeType!, context, modelName, methodName);

	const overrideUserId = await resolveAdminOverride(cleanArgs, config, context);
	delete cleanArgs.targetUserId;
	delete cleanArgs.action;

	if (config.injectArgs) {
		for (const [key, value] of Object.entries(
			config.injectArgs as Record<string, unknown>,
		)) {
			if (methodName === "updateMany") {
				// The strict bulk gate accepts ONLY `where` and `data` — an injected
				// arg written top-level would be refused as an ambiguous stray.
				const data = cleanArgs.data;
				if (
					data &&
					typeof data === "object" &&
					!Array.isArray(data) &&
					(data as Record<string, unknown>)[key] === undefined
				) {
					(data as Record<string, unknown>)[key] = value;
				}
				continue;
			}
			if (cleanArgs[key] === undefined || cleanArgs[key] === null) {
				cleanArgs[key] = value;
			}
		}
	}

	if (config.auditFields) {
		const af = config.auditFields as Record<string, string>;
		const userId = context.userId || "system";
		if (
			methodName === "create" ||
			methodName === "createMany" ||
			methodName === "upsert"
		) {
			for (const field of Object.values(af)) {
				if (modelHasField(modelName, field)) {
					cleanArgs[field] ??= userId;
				}
			}
		} else if (methodName === "update") {
			if (af.updated_by && modelHasField(modelName, af.updated_by)) {
				cleanArgs[af.updated_by] ??= userId;
			}
		} else if (
			methodName === "updateMany" &&
			af.updated_by &&
			modelHasField(modelName, af.updated_by)
		) {
			// The strict bulk gate accepts ONLY `where` and `data` — the audit
			// stamp belongs inside `data`, never at the top level where the gate
			// would refuse it as an ambiguous stray.
			const data = cleanArgs.data;
			if (data && typeof data === "object" && !Array.isArray(data)) {
				(data as Record<string, unknown>)[af.updated_by] ??= userId;
			}
		}
	}

	const resolvedContext = overrideUserId
		? { ...context, userId: overrideUserId }
		: { ...context };

	return { cleanArgs, fieldsParam, resolvedContext, overrideUserId, defaultsApplied, defaultTake };
}
