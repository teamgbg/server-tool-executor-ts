/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import { getFullTextSearchInfo } from "#tool-executor/lib/fts-registry.ts";
import type {
	ExecutionContext,
	OrpcExecutorConfig,
} from "@teamscala/tool-executor-substrate/lib/types.ts";
import {
	mergeDirectMatchIds,
	queryDirectMatchIds,
	resolveFullTextSearchIds,
} from "../orpc-search";

const logger = getLogger();

export async function preprocessSearch(
	cleanArgs: Record<string, unknown>,
	resolvedConfig: OrpcExecutorConfig,
	modelName: string,
	resolvedContext: ExecutionContext,
): Promise<void> {
	if (!cleanArgs.search) return;

	let searchQuery = String(cleanArgs.search).trim();
	if (!searchQuery) {
		delete cleanArgs.search;
		return;
	}

	searchQuery = searchQuery.slice(0, 500);
	let resolved = false;

	const searchable = await getFullTextSearchInfo(modelName);

	if (searchable) {
		const ftsIds = await resolveFullTextSearchIds(
			searchQuery,
			modelName,
			resolvedContext,
		);
		if (ftsIds.length > 0) {
			const mergedIds = await mergeDirectMatchIds(
				ftsIds,
				cleanArgs,
				resolvedConfig,
				modelName,
				resolvedContext,
			);
			const where = (cleanArgs.where as Record<string, unknown>) || {};
			where.id = { in: mergedIds };
			cleanArgs.where = where;
			resolved = true;
			logger.info(
				`[Full-Text Search] Found ${ftsIds.length} FTS + ${mergedIds.length - ftsIds.length} direct matches for "${searchQuery}" in ${modelName}`,
			);
		}
	}

	if (!resolved && resolvedConfig.directMatchFields) {
		const directIds = await queryDirectMatchIds(
			cleanArgs,
			resolvedConfig,
			modelName,
			resolvedContext,
		);
		if (directIds.length > 0) {
			const where = (cleanArgs.where as Record<string, unknown>) || {};
			where.id = { in: directIds };
			cleanArgs.where = where;
			resolved = true;
			logger.info(
				`[Direct Match] Found ${directIds.length} matches by exact field in ${modelName}`,
			);
		}
	}

	if (!resolved && resolvedConfig.searchFields?.length) {
		const sanitizedSearch = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "");
		const where = (cleanArgs.where as Record<string, unknown>) || {};
		where.OR = resolvedConfig.searchFields.map((field: string) => ({
			[field]: resolvedConfig.searchCaseSensitive
				? { contains: sanitizedSearch }
				: { contains: sanitizedSearch, mode: "insensitive" },
		}));
		cleanArgs.where = where;
		logger.info(
			`[Text Search] Searching ${resolvedConfig.searchFields.join(", ")} for "${sanitizedSearch}"`,
		);
	}

	delete cleanArgs.search;
}
