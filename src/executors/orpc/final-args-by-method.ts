/**
 * @system mcp-infrastructure
 * @status handwritten
 */
import { injectScopeFilter } from "@teamscala/tool-executor-scope/lib/scope.ts";
import { addScopeToWhere } from "@teamscala/tool-executor-scope/lib/scope.ts";
import type {
	ExecutionContext,
	OrpcExecutorConfig,
} from "@teamscala/tool-executor-substrate/lib/types.ts";
import {
	buildCreateData,
	buildFindManyArgs,
	buildUpdateArgs,
} from "../orpc-args";
import {
	buildStrictBulkMutationArgs,
	isObjectWithKeys,
} from "../orpc-bulk-gate";
import { liftRemainingColumnFilters } from "../orpc-args-where";
import {
	applyWhereConstraint,
	rejectForbiddenFieldValues,
	requireCompleteIdentity,
} from "./prepare-args-guard.ts";

// Prisma client method names that produce a CRUD-shaped Prisma invocation.
// Anything else is a row-composed fn procedure (orpc-bundle from api_route rows)
// (registry_edit, puck_set, send_orchestrator_message, …) — for those the
// CRUD reshape below would strip non-standard fields, so we passthrough.
const STANDARD_CRUD_METHODS = new Set<string>([
	"findMany",
	"findUnique",
	"findFirst",
	"count",
	"create",
	"createMany",
	"update",
	"updateMany",
	"upsert",
	"delete",
	"deleteMany",
	"aggregate",
	"groupBy",
]);

export function buildFinalArgsByMethod(
	methodName: string,
	modelName: string,
	cleanArgs: Record<string, unknown>,
	fieldsParam: string[] | undefined,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
): Record<string, unknown> {
	if (config.passthrough) {
		return { ...cleanArgs };
	}

	// Passthrough via config.passthrough or auto-detected for non-CRUD names.
	// Row-composed fn procedures take arbitrary
	// input shapes — forwarding is the only correct shape when methodName
	// is not in the Prisma CRUD vocabulary.
	if (!STANDARD_CRUD_METHODS.has(methodName)) {
		return { ...cleanArgs };
	}

	let finalArgs: Record<string, unknown>;
	const pkField = config.identifierField || config.idField || "id";
	const keyFields = config.identifierFields?.length
		? config.identifierFields
		: [pkField];
	if (methodName === "findUnique" || methodName === "delete" || methodName === "update") {
		requireCompleteIdentity(cleanArgs, keyFields, methodName);
	}

	const baseSelect = (): Record<string, boolean> =>
		Object.fromEntries(keyFields.map((field) => [field, true]));

	if (methodName === "findMany") {
		finalArgs = buildFindManyArgs(cleanArgs, config, context, modelName);
		if (fieldsParam?.length) {
			const select = baseSelect();
			for (const f of fieldsParam) select[f] = true;
			finalArgs.select = select;
		}
	} else if (methodName === "create" || methodName === "createMany") {
		finalArgs = buildCreateData(cleanArgs, config, context, modelName);
		if (methodName === "create") {
			const writeSelect = baseSelect();
			if (fieldsParam?.length) {
				for (const f of fieldsParam) writeSelect[f] = true;
			}
			finalArgs.select = writeSelect;
		}
	} else if (methodName === "updateMany") {
		// STRICT NAMESPACE GATE (2026-08-16 incident): update_many accepts ONLY
		// `where` (filter object) and `data` (set-values object). The flat
		// top-level columns this schema also offers are filters for list/count
		// and set-values for update — for a bulk mutation that duality is
		// unresolvable at the call site, and one flat call
		// (kind/title/organisation_id, no `where`) rewrote 6,890 work_items
		// titles org-wide while reporting success. buildStrictBulkMutationArgs
		// refuses every other shape BEFORE any arg building, then the validated
		// pair flows through buildUpdateArgs for the shared coercions, scope
		// injection and autoInject handling.
		const strict = buildStrictBulkMutationArgs("updateMany", cleanArgs);
		finalArgs = buildUpdateArgs(
			{ where: strict.where, data: strict.data },
			config,
			context,
			modelName,
		);
	} else if (methodName === "update") {
		finalArgs = buildUpdateArgs(cleanArgs, config, context, modelName);
		const whereObject = (finalArgs.where as Record<string, unknown>) || {};
		// A unique-address method with no identity in `where` reaches Prisma as
		// where:{} (or org-scope only) and fails with Prisma's own echo instead
		// of the tool's contract. Refuse HERE, naming both working shapes —
		// measured 2026-08-20 on the builda_pages generated tool: every
		// update call that wrapped its id inside `data` died this way.
		if (!keyFields.some((field) => whereObject[field] !== undefined)) {
			throw new Error(
				`"update" needs a row address — pass the identity top-level ` +
					`({action:"update", ${keyFields.join(", ")}: "…", data:{…}}) or inside \`where\` ` +
					`({where:{${keyFields[0]}:"…"}, data:{…}}). An update without an address cannot proceed.`,
			);
		}
		const dataObject = (finalArgs.data as Record<string, unknown>) || {};
		if (Object.keys(dataObject).length === 0) {
			throw new Error(`"update" requires at least one field to update`);
		}
		const writeSelect = baseSelect();
		if (fieldsParam?.length) {
			for (const f of fieldsParam) writeSelect[f] = true;
		}
		finalArgs.select = writeSelect;
	} else if (methodName === "upsert") {
		const updateArgs = buildUpdateArgs(cleanArgs, config, context, modelName);
		const createArgs = buildCreateData(cleanArgs, config, context, modelName);

		finalArgs = {
			where: updateArgs.where,
			update: updateArgs.data,
			create: createArgs.data,
		};

		const writeSelect = baseSelect();
		if (fieldsParam?.length) {
			for (const f of fieldsParam) writeSelect[f] = true;
		}
		finalArgs.select = writeSelect;
	} else if (methodName === "findUnique") {
		const suppliedWhere = (cleanArgs.where as Record<string, unknown>) || {};
		const whereKeyFields = keyFields.filter((field) => suppliedWhere[field] !== undefined);
		if (keyFields.length > 1 && whereKeyFields.length > 0 && whereKeyFields.length !== keyFields.length) {
			throw new Error(
				`"findUnique" requires all composite identity fields: ${keyFields.join(", ")}`,
			);
		}
		const where = Object.fromEntries(
			keyFields.map((field) => [field, cleanArgs[field] ?? suppliedWhere[field]]),
		);
		finalArgs = { where };
		if (fieldsParam?.length) {
			const select = baseSelect();
			for (const f of fieldsParam) select[f] = true;
			finalArgs.select = select;
		}
	} else if (methodName === "delete") {
		const suppliedWhere = (cleanArgs.where as Record<string, unknown>) || {};
		const where: Record<string, unknown> = Object.fromEntries(
			keyFields.map((field) => [field, cleanArgs[field] ?? suppliedWhere[field]]),
		);
		injectScopeFilter(where, config, context, modelName);
		finalArgs = { where };
	} else if (methodName === "deleteMany") {
		// Same strict namespace gate as updateMany: `where` object only. The
		// historical flat-filter lifting made an unscoped delete expressible
		// whenever any top-level column happened to look like a filter.
		if (cleanArgs[pkField] !== undefined && !isObjectWithKeys(cleanArgs.where)) {
			cleanArgs.where = { [pkField]: cleanArgs[pkField] };
			delete cleanArgs[pkField];
		}
		const strict = buildStrictBulkMutationArgs("deleteMany", cleanArgs);
		const deleteWhere: Record<string, unknown> = { ...strict.where };
		injectScopeFilter(deleteWhere, config, context, modelName);
		finalArgs = { where: deleteWhere };
	} else {
		const where: Record<string, unknown> =
			(cleanArgs.where as Record<string, unknown>) || {};
		// Read path (count/findFirst/aggregate/groupBy): flatFilterFields → eq,
		// searchFields → case-insensitive contains (partial-match "Searchable by"
		// semantic). Mirrors extractFlatFilters({searchFieldMode:"contains"}) on
		// the findMany path; a field in BOTH sets keeps the eq value (where already set).
		for (const field of config.flatFilterFields ?? []) {
			if (field === "search") continue;
			if (cleanArgs[field] === undefined) continue;
			where[field] =
				typeof cleanArgs[field] === "number"
					? String(cleanArgs[field])
					: cleanArgs[field];
			delete cleanArgs[field];
		}
		for (const field of config.searchFields ?? []) {
			if (field === "search") continue;
			if (where[field] !== undefined) continue;
			if (cleanArgs[field] === undefined) continue;
			const v = cleanArgs[field];
			where[field] =
				typeof v === "string" ? { contains: v, mode: "insensitive" } : v;
			delete cleanArgs[field];
		}
		// `findFirst` powers every generated `get` action. Keep it behaviorally
		// aligned with `findMany`: a schema-exposed real column such as docs.path
		// is a filter even when it is not in the curated flat/search field sets.
		liftRemainingColumnFilters(cleanArgs, where, modelName);
		if (cleanArgs[pkField] && !where[pkField]) {
			where[pkField] = cleanArgs[pkField];
			delete cleanArgs[pkField];
		}
		const allowedReadArgs = [
			"take",
			"skip",
			"orderBy",
			"cursor",
			"distinct",
			"select",
			"include",
		];
		const narrowedArgs: Record<string, unknown> = { where };
		for (const argKey of allowedReadArgs) {
			if (cleanArgs[argKey] !== undefined) {
				narrowedArgs[argKey] = cleanArgs[argKey];
			}
		}
		finalArgs = addScopeToWhere(narrowedArgs, config, context, modelName);
		if (methodName === "findFirst" && fieldsParam?.length) {
			const select = baseSelect();
			for (const f of fieldsParam) select[f] = true;
			finalArgs.select = select;
		}
	}

	rejectForbiddenFieldValues(finalArgs, config.forbiddenFieldValues);
	return methodName === "create" ||
		methodName === "createMany" ||
		methodName === "update" ||
		methodName === "delete"
		? finalArgs
		: applyWhereConstraint(finalArgs, config.whereConstraint);
}
