/**
 * @system tool-executor
 * @status handwritten
 */

import type { PrismaClient } from "@teamscala/db/client";
import type { DynamicPrismaClient } from "@teamscala/tool-executor-substrate/lib/types.ts";

const ENUMERATION_CAP = 200;

export interface BulkTargetEnumeration {
	affected: Array<Record<string, unknown>>;
	affected_truncated: boolean;
}

export async function enumerateBulkTargets(
	prisma: PrismaClient,
	modelName: string,
	where: Record<string, unknown>,
	keyFields: string[],
): Promise<BulkTargetEnumeration> {
	const model = (prisma as unknown as DynamicPrismaClient)[modelName];
	if (!model?.findMany) {
		// No delegate (or DMMF-unknown model) — the mutation itself will fail
		// loud at the router boundary; an enumeration crash must not pre-empt
		// it with a different, less actionable error.
		return { affected: [], affected_truncated: false };
	}
	const select = Object.fromEntries(keyFields.map((field) => [field, true]));
	const rows = (await model.findMany({
		where,
		select,
		take: ENUMERATION_CAP + 1,
	})) as Array<Record<string, unknown>>;
	return {
		affected: rows.slice(0, ENUMERATION_CAP),
		affected_truncated: rows.length > ENUMERATION_CAP,
	};
}
