/**
 * @system tool-executor
 * @status handwritten
 */

import { createRouterClient as createCaller, type AnyRouter } from "@orpc/server";
import { getAppRouter, getLogger, getPrisma } from "@teamscala/tool-executor-substrate/configure.ts";
import { getFullTextSearchInfo } from "@teamscala/tool-executor-scope/lib/fts-registry.ts";
import { injectScopeFilter } from "@teamscala/tool-executor-scope/lib/scope.ts";
import { queryRowsUnsafe } from "@teamscala/db/query-rows";
import type { ExecutionContext, OrpcExecutorConfig } from "@teamscala/tool-executor-substrate/lib/types.ts";

const logger = getLogger();

/**
 * Look up matching record IDs for an ORPC tool's model via Postgres
 * full-text search on the table's search_content_tsv column (GIN-indexed,
 * trigger/generated-column maintained). Tables without the column return []
 * and the caller falls back to direct field matching.
 */
export async function resolveFullTextSearchIds(
	query: string,
	sourceType: string,
	context: ExecutionContext,
): Promise<string[]> {
	try {
		const info = await getFullTextSearchInfo(sourceType);
		if (!info) return [];
		// Table names come from information_schema, but belt-and-braces before
		// interpolating into SQL.
		if (!/^[a-z0-9_]+$/.test(sourceType)) return [];
		// Tenant-scoped tables require an org context; tables without an
		// organisation_id column (e.g. product_attachments) scope via their
		// parent in the final router query.
		if (info.hasOrgColumn && !context.organisationId) return [];

		// Dynamic-table FTS: a generated procedure can't carry a runtime-bound
		// table name; the one-db-surface raw is the sanctioned shape (per
		// the platform's raw consumption rule). Source type is name-validated
		// above (^[a-z0-9_]+$) before interpolation.
		const orgClause = info.hasOrgColumn ? "AND organisation_id = $2" : "";
		const params: unknown[] = info.hasOrgColumn
			? [query, context.organisationId]
			: [query];
		const ids = (await queryRowsUnsafe<{ id: string }[]>(
			`
				SELECT id FROM ${sourceType}
				WHERE search_content_tsv @@ websearch_to_tsquery('english', $1)
				  ${orgClause}
				ORDER BY ts_rank(search_content_tsv, websearch_to_tsquery('english', $1)) DESC
				LIMIT 20
			`,
			...params,
		)) ?? [];
		return ids.map((r) => r.id);
	} catch (err) {
		logger.warn(`[Full-Text Search] Failed for ${sourceType}: ${err}`);
		return [];
	}
}

/**
 * Query the DB for records matching directMatchFields values from the input.
 * Uses case-insensitive contains to handle format differences
 * (e.g. "0489150186" matches "+61489150186").
 */
export async function queryDirectMatchIds(
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	modelName: string,
	context: ExecutionContext,
): Promise<string[]> {
	if (!config.directMatchFields) return [];

	const orConditions: Record<string, unknown>[] = [];
	for (const [inputParam, dbColumn] of Object.entries(
		config.directMatchFields,
	)) {
		const value = input[inputParam];
		if (value !== undefined && value !== null && String(value).trim()) {
			orConditions.push({
				[dbColumn]: { contains: String(value).trim(), mode: "insensitive" },
			});
		}
	}
	if (orConditions.length === 0) return [];

	try {
		const db = getPrisma() as {
			$queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>;
		};
		const appRouter = await getAppRouter();
		const router = (appRouter as unknown as Record<string, unknown>)[modelName];
		if (!router) return [];

		const caller = createCaller(
			router as unknown as AnyRouter,
			{ context: { prisma: db } },
		);
		const scopeWhere: Record<string, unknown> = {};
		injectScopeFilter(scopeWhere, config, context);

		const pkField = config.identifierField || config.idField || "id";
		const result = await (caller as unknown as Record<string, (args: unknown) => Promise<unknown>>).findMany({
			where: { ...scopeWhere, OR: orConditions },
			select: { [pkField]: true },
			take: 10,
		});

		const resultView = result as { data?: unknown };
		const rows = Array.isArray(resultView.data)
			? resultView.data
			: Array.isArray(result)
				? result
				: [];
		const ids = rows.map((r: Record<string, unknown>) => String(r[pkField])).filter(Boolean);
		if (ids.length > 0) {
			logger.info(
				`[Direct Match] Found ${ids.length} by ${Object.keys(config.directMatchFields).join("/")} in ${modelName}`,
			);
		}
		return ids;
	} catch (err) {
		logger.warn(`[Direct Match] Failed for ${modelName}: ${err}`);
		return [];
	}
}

/**
 * Merge full-text-search IDs with direct field match IDs, deduplicating.
 */
export async function mergeDirectMatchIds(
	searchIds: string[],
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	modelName: string,
	context: ExecutionContext,
): Promise<string[]> {
	const directIds = await queryDirectMatchIds(
		input,
		config,
		modelName,
		context,
	);
	if (directIds.length === 0) return searchIds;

	// Deduplicate: direct matches first (exact), then full-text ranked
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const id of [...directIds, ...searchIds]) {
		if (!seen.has(id)) {
			seen.add(id);
			merged.push(id);
		}
	}
	return merged;
}
