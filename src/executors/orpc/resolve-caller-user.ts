/**
 * @system tool-executor
 * @status handwritten
 */

/**
 * The DB surface resolveCallerUser reads: the stored user record (role +
 * existence) and the BetterAuth membership table. resolveUserOrganisationId
 * (@teamscala/db) queries it as `db.member`, but the services that mount
 * tool-executor (scala-mcp et al.) generate their Prisma client by live
 * introspection, which names models by TABLE — so the membership table is
 * exposed as `better_auth_member`, not `member`. resolveCallerUser bridges
 * that (below) by handing resolveUserOrganisationId a `{ member:
 * db.better_auth_member }` view; the delegate, the columns, and the findFirst
 * shape are identical. Declared narrowly so the co-located test mocks exactly
 * these two delegates.
 */

	// (2) + (3) Non-super-admin named caller: resolve through
	// resolveUserOrganisationId (@teamscala/db) — reuse, not a new resolver.
	//  - org ASSERTED: the function returns it ONLY when a (userId, assertedOrg)
	//    member row exists; otherwise it falls back to the caller's own org (a
	//    DIFFERENT id) or undefined. `resolved !== assertedOrg` is therefore the
	//    non-membership signal → REFUSE. We never serve the caller's own org for
	//    an explicit foreign-org request: that silent redirect is the worse
	//    failure (the caller believes it got B; it got A).
	//  - no org claim: resolve the caller's OWN membership (may be undefined →
	//    the generated protectedProcedure then refuses on "no org, not
	//    super-admin").

import {
	resolveUserOrganisationId,
	type UserOrganisationDb,
} from "@teamscala/db/user-organisations";
import { isSystemCaller, SYSTEM_USER_ID } from "#tool-executor/lib/system-caller.ts";

export interface CallerUserContext {
	userId?: string;
	organisationId?: string;
}

export interface CallerUserDb {
	user: {
		findUnique(args: {
			where: { id: string };
			select: { role: true };
		}): Promise<{ role: string | null } | null>;
	};
	better_auth_member: {
		findFirst<TResult = unknown>(args: {
			where: Record<string, unknown>;
			orderBy?: Record<string, unknown>;
			select: Record<string, true>;
		}): Promise<TResult | null>;
	};
}

export interface ResolvedCallerUser {
	userId: string;
	id: string;
	organisationId: string | null;
	isSuperAdmin: boolean;
}

/**
 * Resolve the ORPC router caller-user from the identity context + stored
 * record. Throws (Authorization required: …) on any refusal — matching the
 * lib/auth.ts validateAuth refusal shape, so a refusal surfaces as an error
 * exactly like "X-Organisation-Id header is missing" does. Never returns a
 * user for a caller that has not been verified (a-component-may-not-report-
 * a-state-it-has-not-verified): an anonymous, unknown, or non-member caller
 * is refused rather than handed an org-scoped context it did not earn.
 */
export async function resolveCallerUser(
	db: CallerUserDb,
	ctx: CallerUserContext,
): Promise<ResolvedCallerUser> {
	const assertedOrg = ctx.organisationId ?? null;

	// (1) The platform SYSTEM sentinel — an internal action authenticated via
	// the loopback bearer — stays super-admin, unchanged. Trusted to assert
	// any org (the system org or a cross-org dev/fleet read); its identity is
	// the sentinel itself, not a row in `user`.
	if (isSystemCaller(ctx.userId)) {
		return {
			userId: SYSTEM_USER_ID,
			id: SYSTEM_USER_ID,
			organisationId: assertedOrg,
			isSuperAdmin: true,
		};
	}

	// Anonymous — no identity reached the decision point. Fail CLOSED: a
	// missing identity is never granted access (system-caller.ts — only the
	// EXPLICIT "system" sentinel is the system caller). The transport now ships
	// x-caller-user-id on every gateway call, so a blank id here is a
	// misconfigured/unauthenticated caller, not a legitimate anonymous path.
	if (!ctx.userId) {
		throw new Error(
			"Authorization required: caller identity (X-User-Id) is missing.",
		);
	}
	const userId = ctx.userId;

	// (4) + (5) Verify the caller EXISTS and derive super-admin from the STORED
	// role — never from a header claim. Treating a claim as a grant would make
	// the super-admin bypass spoofable by whoever can set a header; reading the
	// row makes the verified state unmakeable. An unknown id has no row → refuse.
	const stored = await db.user.findUnique({
		where: { id: userId },
		select: { role: true },
	});
	if (!stored) {
		throw new Error(`Authorization required: unknown caller user ${userId}.`);
	}
	const isSuperAdmin = stored.role === "super_admin";

	// Bridge the introspected-client model name: the membership table is
	// `better_auth_member` on these services, but resolveUserOrganisationId
	// reads it as `db.member`. Same delegate under the name it expects.
	const orgDb = { member: db.better_auth_member } as unknown as UserOrganisationDb;

	// Super-admin (stored role) — the Doris/Joe cross-org bypass, now wired to
	// the role record. Trusted to assert any single org (mirrors the system
	// sentinel), and falls back to its own membership when it asserts none. It
	// is NOT subject to the per-org membership gate: super-admin IS the
	// cross-org escape hatch, and gating it on membership would make the bypass
	// no bypass at all.
	if (isSuperAdmin) {
		const ownOrg =
			assertedOrg ?? (await resolveUserOrganisationId(orgDb, userId)) ?? null;
		return {
			userId,
			id: userId,
			organisationId: ownOrg,
			isSuperAdmin: true,
		};
	}

	let resolvedOrg: string | undefined;
	if (assertedOrg) {
		resolvedOrg = await resolveUserOrganisationId(orgDb, userId, assertedOrg);
		if (resolvedOrg !== assertedOrg) {
			throw new Error(
				`Authorization required: caller ${userId} is not a member of organisation ${assertedOrg}.`,
			);
		}
	} else {
		resolvedOrg = await resolveUserOrganisationId(orgDb, userId);
	}

	return {
		userId,
		id: userId,
		organisationId: resolvedOrg ?? null,
		isSuperAdmin: false,
	};
}
