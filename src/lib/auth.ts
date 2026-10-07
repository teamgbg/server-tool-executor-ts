/**
 * @system tool-executor
 * @status handwritten
 */

import { executeOrpcProcedure } from "../executors/orpc";

const logger = getLogger();

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import { isSystemCaller } from "@teamscala/tool-executor-substrate/lib/system-caller.ts";
import type { ExecutionContext, OrpcExecutorConfig } from "@teamscala/tool-executor-substrate/lib/types.ts";

// ---------------------------------------------------------------------------
// Auth validation (config-driven, no hardcoded model names)
// ---------------------------------------------------------------------------

export function validateAuth(
	scopeType: "org" | "user" | "public",
	context: ExecutionContext,
	modelName: string,
	methodName: string,
): void {
	// Public scope doesn't require context
	if (scopeType === "public") {
		return;
	}

	// Admin / system bypass — skip org/user requirements for cross-org access.
	// MUST match injectScopeFilter's bypass exactly: the same system caller
	// (the explicit "system" sentinel) that injectScopeFilter lets through
	// unscoped must ALSO skip the org/user presence gate here. If only one
	// layer bypassed, validateAuth would HONOUR X-Organisation-Id for presence
	// while injectScopeFilter DROPPED it for filtering — the
	// accepted-then-discarded inconsistency that fooled callers into believing
	// org-scoping was enforced when it was silently bypassed.
	if (context.isAdmin || isSystemCaller(context.userId)) {
		return;
	}

	// Org and user scopes require organisationId
	if (!context.organisationId) {
		throw new Error(
			`Authorization required: X-Organisation-Id header is missing. ` +
				`Cannot execute ${modelName}.${methodName} without organisation context.`,
		);
	}

	// Write operations require userId
	if (
		[
			"create",
			"createMany",
			"update",
			"updateMany",
			"delete",
			"deleteMany",
			"upsert",
		].includes(methodName)
	) {
		if (!context.userId) {
			throw new Error(
				`Authorization required: X-User-Id header is missing. ` +
					`Cannot execute ${modelName}.${methodName} without user context.`,
			);
		}
	}

	// User scope additionally requires userId for reads
	if (scopeType === "user" && !context.userId) {
		throw new Error(
			`Authorization required: X-User-Id header is missing. ` +
				`Cannot execute ${modelName}.${methodName} without user context.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Admin override — lets org admins query another user's data
// ---------------------------------------------------------------------------

async function isOrgAdmin(
	userId: string,
	organisationId: string,
	context: ExecutionContext,
	config: OrpcExecutorConfig,
): Promise<boolean> {
	try {
		return (await executeOrpcProcedure(
			"fn.auth.isOrgAdmin",
			{ userId, organisationId },
			context,
			config,
		)) as boolean;
	} catch (e) {
		logger.warn(
			`[Executor] Failed to check admin status for ${userId} in org ${organisationId}`,
			{ error: e },
		);
		return false;
	}
}

/**
 * Resolves admin override: if the AI passes targetUserId, verify the requester
 * is an org admin and return the target user ID. Returns null for normal flow.
 */
export async function resolveAdminOverride(
	args: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
): Promise<string | null> {
	const targetUserId = args.targetUserId as string | undefined;
	if (!targetUserId) return null;

	// Self-targeting is a no-op — no admin check needed
	if (targetUserId === context.userId) return null;

	if (!config.adminOverride) {
		throw new Error(
			`This tool does not support admin override. ` +
				`Remove targetUserId from the request.`,
		);
	}

	if (!context.userId || !context.organisationId) {
		throw new Error(
			`Admin override requires both user and organisation context.`,
		);
	}

	const admin = await isOrgAdmin(
		context.userId,
		context.organisationId,
		context,
		config,
	);
	if (!admin) {
		throw new Error(
			`Access denied: you must be an org admin or owner to view another user's data.`,
		);
	}

	logger.info(`[Executor] Admin override: ${context.userId} → ${targetUserId}`);
	return targetUserId;
}
