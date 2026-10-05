/**
 * @system tool-executor
 * @status handwritten
 */

import type { ExecutionContext } from "../lib/types.ts";

export type CallerCliSession = {
	id: string;
	label: string;
	role: string;
};

type SessionLookup = {
	cli_sessions: {
		findFirst(args: unknown): Promise<CallerCliSession | null>;
	};
};

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findOpenCliSessionById(
	prisma: unknown,
	sessionId: string | null | undefined,
): Promise<CallerCliSession | null> {
	if (!sessionId || !UUID.test(sessionId)) return null;
	const delegate = (prisma as SessionLookup).cli_sessions;
	if (!delegate?.findFirst) return null;
	return delegate.findFirst({
		where: { closed_at: null, id: sessionId },
		select: { id: true, label: true, role: true },
	});
}

export async function resolveCallerCliSession(
	prisma: unknown,
	context: ExecutionContext,
): Promise<CallerCliSession | null> {
	return findOpenCliSessionById(
		prisma,
		context.callerInfo?.orchestratorSessionId,
	);
}
