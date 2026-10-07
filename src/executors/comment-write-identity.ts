/**
 * @system tool-executor
 * @status handwritten
 */

import type { ExecutionContext } from "@teamscala/tool-executor-substrate/lib/types.ts";
import { findOpenCliSessionById } from "./caller-cli-session.ts";

type CommentSession = {
	id: string;
	label: string;
	role: string;
};

type CommentAgent = {
	id: string;
	name: string | null;
};

type SessionLookup = {
	cli_sessions: {
		findFirst(args: unknown): Promise<CommentSession | null>;
	};
	ai_agents: {
		findFirst(args: unknown): Promise<CommentAgent | null>;
	};
};

export type DerivedCommentIdentity = {
	agent_id: string | null;
	source_cli_session_id: string | null;
	sender_name: string | null;
	sender_role: "orchestrator" | "lane" | "operator" | "system";
};

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `SCALA_ORCH_SESSION_ID=tmux:%<pane>` is the CLI's durable live-pane identity. */
function paneFromOrchestratorSession(value: string | null | undefined): string | null {
	if (!value?.startsWith("tmux:%")) return null;
	return value.slice("tmux:".length);
}

function callerCandidates(context: ExecutionContext): {
	ids: string[];
	panes: string[];
	label: string | null;
} {
	const info = context.callerInfo;
	const ids = [info?.orchestratorSessionId].filter(
		(value): value is string => typeof value === "string" && UUID.test(value),
	);
	const panes = [
		info?.tmuxTarget,
		info?.tmuxSession,
		paneFromOrchestratorSession(info?.orchestratorSessionId),
		paneFromOrchestratorSession(info?.orchestratorId),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return {
		ids: [...new Set(ids)],
		panes: [...new Set(panes)],
		label: info?.label?.trim() || null,
	};
}

async function resolveSession(
	prisma: unknown,
	context: ExecutionContext,
): Promise<CommentSession | null> {
	const candidates = callerCandidates(context);
	const [sessionId] = candidates.ids;
	// One home for the lookup (caller-cli-session): the comment path and the
	// RLS write path resolve the same verified open session.
	return findOpenCliSessionById(prisma, sessionId);
}

/** Resolve the author once, then overwrite all three caller-controlled fields. */
export async function deriveCommentIdentity(
	prisma: unknown,
	context: ExecutionContext,
): Promise<DerivedCommentIdentity> {
	const delegate = prisma as SessionLookup;
	if (context.agentId?.trim()) {
		const agentIdentity = context.agentId.trim();
		// AN UNUSABLE CLIENT MUST FAIL LOUDLY, NEVER RESOLVE TO "DOES NOT EXIST".
		// `prisma` is typed unknown and cast, so the compiler cannot catch a
		// wrong-shaped argument; the previous `ai_agents?.findFirst` spent the
		// only runtime chance to notice, turning a client-shape error into a
		// false claim that the agent is missing. SessionLookup.ai_agents is
		// NON-optional — the chain guarded a case the type forbids.
		if (typeof delegate?.ai_agents?.findFirst !== "function") {
			throw new TypeError(
				`deriveCommentIdentity: the supplied client exposes no ai_agents.findFirst — ` +
					`received ${prisma === null ? "null" : typeof prisma}` +
					`${
						prisma && typeof prisma === "object"
							? ` with keys [${Object.keys(prisma).slice(0, 8).join(", ")}]`
							: ""
					}. This is a CLIENT shape error, not a missing agent: pass the Prisma model ` +
					`client, never a raw pooled connection or transaction.`,
			);
		}
		const agent = await delegate.ai_agents.findFirst({
			where: { OR: [{ id: agentIdentity }, { slug: agentIdentity }] },
			select: { id: true, name: true },
		});
		if (!agent) {
			throw new Error(`comments.create caller agent ${context.agentId} does not exist`);
		}
		return {
			agent_id: agent.id,
			source_cli_session_id: null,
			sender_name: agent.name,
			sender_role: "system",
		};
	}

	const session = await resolveSession(prisma, context);
	if (session) {
		const isWorker = session.role !== "orchestrator";
		return {
			agent_id: null,
			source_cli_session_id: session.id,
			// NULL, NOT session.label. The comments table carries `comments_session_sender_name_is_derived`: CHECK (source_cli_session_id IS NULL OR sender_name IS NULL).
			// A session-authored comment therefore may not also store a name — the name is DERIVED by joining cli_sessions at render time, which
			// is what "is_derived" in the constraint name asserts.
			//
			// Storing it broke EVERY lane's ability to comment for over an hour on 2026-08-13: each write violated the check, and because peer
			// delivery and orchestrator reporting both route through
			// comments.create, no lane could report that reporting was down.
			// A stored copy of a session's label is also the second copy of a
			// fact the session row already owns, so it drifts the moment a lane
			// is renamed (`identity-is-imported-never-spelled`).
			sender_name: null,
			sender_role: isWorker ? "lane" : "orchestrator",
		};
	}

	const userId = context.userId?.trim();
	if (userId && userId !== "system") {
		return {
			agent_id: null,
			source_cli_session_id: null,
			sender_name: null,
			sender_role: "operator",
		};
	}

	// NAME WHAT WAS TRIED. This threw a bare sentence, so a caller learned only that identity failed — not whether the headers were absent, the session
	// lookup missed, or the agent id was empty. Measured 2026-08-11: diagnosing
	// one refusal took several hours of source reading precisely because the
	// resolver discarded the evidence it was holding, and the deployed service
	// emitted nothing (`friction-is-a-stop-condition`: a component that knows
	// why it failed and only RETURNS the reason destroys the answer in transit).
	//
	// The candidates are caller-supplied identifiers, never secrets, so naming
	// them is safe and makes the next failure answerable in one line instead of
	// an investigation.
	const attempted = callerCandidates(context);
	throw new Error(
		"comments.create caller identity could not be resolved; refusing anonymous comment " +
			`(agentId=${context.agentId?.trim() || "none"} ` +
			`userId=${context.userId?.trim() || "none"} ` +
			`sessionIds=[${attempted.ids.join(",") || "none"}] ` +
			`panes=[${attempted.panes.join(",") || "none"}] ` +
			`label=${attempted.label ?? "none"} ` +
			`callerInfoPresent=${context.callerInfo ? "yes" : "NO"})`,
	);
}

export function applyDerivedCommentIdentity(
	finalArgs: Record<string, unknown>,
	identity: DerivedCommentIdentity,
): void {
	const data = (finalArgs.data ?? {}) as Record<string, unknown>;
	delete data.agent_id;
	delete data.sender_name;
	delete data.sender_role;
	delete data.source_cli_session_id;
	data.agent_id = identity.agent_id;
	data.sender_name = identity.sender_name;
	data.sender_role = identity.sender_role;
	data.source_cli_session_id = identity.source_cli_session_id;
	finalArgs.data = data;
}
