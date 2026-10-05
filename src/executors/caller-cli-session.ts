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

/**
 * Look up an OPEN cli_sessions row by id. Returns null for a non-UUID, a
 * closed session, or an id from any other namespace — absence is the honest
 * answer for an unattributable caller, never a fallback identity.
 *
 * The session-id candidate is the launcher-injected SCALA_FLEET_CLI_SESSION_ID
 * the CLI expands into the caller header.
 */
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

/**
 * The calling lane's verified session for write attribution: the session-id
 * candidate carried by the request context (the launcher-injected
 * `SCALA_FLEET_CLI_SESSION_ID`, expanded into the caller header by the CLI),
 * validated open by `findOpenCliSessionById`.
 */
export async function resolveCallerCliSession(
	prisma: unknown,
	context: ExecutionContext,
): Promise<CallerCliSession | null> {
	return findOpenCliSessionById(
		prisma,
		context.callerInfo?.orchestratorSessionId,
	);
}
