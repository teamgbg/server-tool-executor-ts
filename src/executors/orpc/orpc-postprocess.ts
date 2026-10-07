/**
 * @system tool-executor
 * @status handwritten
 */

import type { PrismaClient } from "@teamscala/db/client";
import { addPaginationHint } from "#tool-executor/lib/default-limits.ts";
import {
	compactTranscriptFields,
	executeWithCount,
	normalizeJsonResponse,
	truncateLargeResponse,
} from "#tool-executor/lib/response.ts";
import type {
	DynamicPrismaClient,
	ExecutionContext,
	OrpcExecutorConfig,
} from "@teamscala/tool-executor-substrate/lib/types.ts";
import { applyEnrichment } from "../orpc-enrichment";

export async function postProcessResult(
	result: unknown,
	methodName: string,
	modelName: string,
	finalArgs: Record<string, unknown>,
	context: ExecutionContext,
	config: OrpcExecutorConfig,
	prisma: PrismaClient,
	defaultsApplied: boolean = false,
	defaultTake: number | null = null,
) {
	// The ORPC result is opaque (`unknown`); view it as an optional data wrapper
	// for the scope-check + enrichment branches below.
	const resultView = result as { data?: unknown } | null;
	if (
		methodName === "findUnique" &&
		config.scopeType !== "public" &&
		resultView?.data &&
		!context.isAdmin
	) {
		const record = resultView.data as Record<string, unknown>;
		const orgField = config.orgField || "organisation_id";

		if (config.scopeType === "org" && !record[orgField]) {
			throw new Error(
				`Access denied: record missing required organisation scoping`,
			);
		}

		if (
			context.organisationId &&
			record[orgField] &&
			record[orgField] !== context.organisationId
		) {
			throw new Error(
				`Access denied: record belongs to a different organisation`,
			);
		}
		const userField = config.userField || "user_id";
		if (
			config.scopeType === "user" &&
			context.userId &&
			record[userField] &&
			record[userField] !== context.userId
		) {
			throw new Error(`Access denied: record belongs to a different user`);
		}
	}

	let enrichedResult: unknown = result;
	if (config.enrich?.length && methodName === "findMany" && resultView?.data) {
		enrichedResult = {
			...(resultView as Record<string, unknown>),
			data: await applyEnrichment(
				resultView.data as Record<string, unknown>[],
				config.enrich,
				prisma as unknown as DynamicPrismaClient,
			),
		};
	}

	const jsonSafeResult = normalizeJsonResponse(enrichedResult);
	const compacted = compactTranscriptFields(jsonSafeResult);
	let processed = truncateLargeResponse(compacted);

	// Attach a pagination hint when default limits were applied so the agent
	// knows it's seeing a subset and how to get more. mcp-result-budget.
	if (defaultsApplied && defaultTake !== null && methodName === "findMany") {
		processed = addPaginationHint(processed, defaultTake);
	}

	if (config.includeCount && methodName === "findMany") {
		return executeWithCount(
			prisma as unknown as DynamicPrismaClient,
			modelName,
			finalArgs,
			processed,
		);
	}

	return processed;
}
