/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger } from "../configure.ts";
import type { DynamicPrismaClient, EnrichConfig } from "../lib/types";

const logger = getLogger();

export async function applyEnrichment(
	rows: Record<string, unknown>[],
	enrichSteps: EnrichConfig[],
	prisma: DynamicPrismaClient,
): Promise<Record<string, unknown>[]> {
	// Work on a mutable copy
	const enrichedRows = rows.map((r) => ({ ...r }));

	for (const step of enrichSteps) {
		const { sourceField, model, matchField, select, as: fieldMap } = step;

		// Collect unique IDs from the source field across all rows
		const ids = [
			...new Set(
				enrichedRows
					.map((r) => r[sourceField])
					.filter((v: unknown) => v !== null && v !== undefined),
			),
		];

		if (ids.length === 0) continue;

		// Build select object for the enrichment query
		const selectObj: Record<string, boolean> = { [matchField]: true };
		for (const field of select) selectObj[field] = true;

		// Query the enrichment model
		const modelClient = prisma[model];
		if (!modelClient?.findMany) {
			logger.warn(`[Enrichment] Model ${model} has no findMany, skipping`);
			continue;
		}

		const enrichmentRows = await modelClient.findMany({
			where: { [matchField]: { in: ids } },
			select: selectObj,
		});

		// Build lookup map: matchField value → enrichment row
		const lookup = new Map<string, Record<string, unknown>>();
		for (const er of enrichmentRows) {
			lookup.set(String(er[matchField]), er);
		}

		// Merge enrichment fields into each row
		for (const row of enrichedRows) {
			const key = row[sourceField] != null ? String(row[sourceField]) : null;
			const match = key ? lookup.get(key) : null;
			for (const [enrichField, outputField] of Object.entries(fieldMap)) {
				row[outputField] = match?.[enrichField] ?? null;
			}
		}
	}

	return enrichedRows;
}
