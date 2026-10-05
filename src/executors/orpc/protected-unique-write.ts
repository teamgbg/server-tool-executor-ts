/**
 * @system tool-executor
 * @status handwritten
 */

import type { PrismaClient } from "@teamscala/db/client";

const PROTECTED_UNIQUE_WRITES = new Set(["update", "delete"]);

export async function assertProtectedUniqueWrite(
	prisma: PrismaClient,
	modelName: string,
	methodName: string,
	finalArgs: Record<string, unknown>,
	whereConstraint: Record<string, unknown> | undefined,
): Promise<void> {
	if (
		!PROTECTED_UNIQUE_WRITES.has(methodName) ||
		!whereConstraint ||
		Object.keys(whereConstraint).length === 0
	) {
		return;
	}
	const delegate = (prisma as unknown as Record<string, Record<string, unknown>>)[modelName];
	const findFirst = delegate?.findFirst;
	if (typeof findFirst !== "function") {
		throw new Error(
			`Cannot authorize protected ${modelName}.${methodName}: model has no findFirst`,
		);
	}
	const target = await (findFirst as (args: unknown) => Promise<unknown>)({
		where: { AND: [finalArgs.where, whereConstraint] },
		select: { id: true },
	});
	if (!target) {
		throw new Error(
			`Protected ${modelName}.${methodName} target is absent or belongs to a subtype owned by another capability`,
		);
	}
}
