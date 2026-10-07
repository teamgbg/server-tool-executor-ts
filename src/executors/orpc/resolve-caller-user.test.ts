// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { SYSTEM_USER_ID } from "#tool-executor/lib/system-caller.ts";
import {
	resolveCallerUser,
	type CallerUserDb,
} from "./resolve-caller-user";

const ORG_A = "c503629a-85d9-4d25-9431-f6fa59504868"; // home org for both named users
const ORG_B = "5b742740-0f37-494c-a059-d8399ae4b350"; // a foreign org neither is a member of
const JOE = "ad9a43d7-9319-43af-862b-63016065a0c2"; // role: super_admin, member of ORG_A only
const DIAH = "diah-0000-0000-0000-000000000001"; // role: user, member of ORG_A only
const BOGUS = "00000000-0000-0000-0000-000000000000"; // no user row at all

/** Mock the two DB delegates resolveCallerUser reads. `users` maps id→stored
 * role (absent = unknown); `memberships` maps id→org ids it belongs to. The
 * member responder models resolveUserOrganisationId exactly: a preferred-org
 * membership check, else a fallback to the caller's own (first) membership. */
function mockDb(
	users: Record<string, string | null>,
	memberships: Record<string, string[]>,
): CallerUserDb {
	return {
		user: {
			findUnique: async ({
				where,
			}: {
				where: { id: string };
				select: { role: true };
			}) => (where.id in users ? { role: users[where.id] } : null),
		},
		better_auth_member: {
			findFirst: async ({
				where,
			}: {
				where: Record<string, unknown>;
			}) => {
				const orgs = memberships[where.user_id as string] ?? [];
				if (where.organization_id) {
					return orgs.includes(where.organization_id as string)
						? { organization_id: where.organization_id }
						: null;
				}
				return orgs.length ? { organization_id: orgs[0] } : null;
			},
		},
	} as unknown as CallerUserDb;
}

const db = mockDb(
	{ [JOE]: "super_admin", [DIAH]: "user" },
	{ [JOE]: [ORG_A], [DIAH]: [ORG_A] },
);

describe("resolveCallerUser", () => {
	test("(1) the 'system' sentinel stays super-admin, unchanged", async () => {
		const u = await resolveCallerUser(db, {
			userId: SYSTEM_USER_ID,
			organisationId: ORG_A,
		});
		expect(u.isSuperAdmin).toBe(true);
		expect(u.userId).toBe("system");
		expect(u.organisationId).toBe(ORG_A);
	});

	test("(5) super-admin derives from the STORED role, never a header", async () => {
		// Joe is role=super_admin → bypass, even though the old code required a
		// header isAdmin that nothing ever populated.
		const u = await resolveCallerUser(db, { userId: JOE, organisationId: ORG_A });
		expect(u.isSuperAdmin).toBe(true);
		expect(u.userId).toBe(JOE);
	});

	test("super-admin honors ANY asserted org (cross-org bypass, not membership-gated)", async () => {
		// Joe is a member of ORG_A ONLY, yet asserts ORG_B. Super-admin is the
		// cross-org escape hatch, so ORG_B is honored — not refused, not
		// silently redirected to ORG_A.
		const u = await resolveCallerUser(db, { userId: JOE, organisationId: ORG_B });
		expect(u.isSuperAdmin).toBe(true);
		expect(u.organisationId).toBe(ORG_B);
	});

	test("(3) a named caller with no org claim resolves its OWN membership", async () => {
		const u = await resolveCallerUser(db, { userId: DIAH });
		expect(u.isSuperAdmin).toBe(false);
		expect(u.organisationId).toBe(ORG_A);
	});

	test("a regular member asserting its own org is org-scoped", async () => {
		const u = await resolveCallerUser(db, { userId: DIAH, organisationId: ORG_A });
		expect(u.isSuperAdmin).toBe(false);
		expect(u.organisationId).toBe(ORG_A);
	});

	test("(2) a named caller asserting an org it is NOT a member of is REFUSED", async () => {
		// diah (role=user) is a member of ORG_A only; asserting ORG_B must throw,
		// never silently fall back to ORG_A (answering an org-B request with
		// org-A data is worse than an error).
		expect(resolveCallerUser(db, { userId: DIAH, organisationId: ORG_B })).rejects
			.toThrow(/not a member of organisation/);
	});

	test("(4) an UNKNOWN user id is REFUSED", async () => {
		expect(
			resolveCallerUser(db, { userId: BOGUS, organisationId: ORG_B }),
		).rejects.toThrow(/unknown caller user/);
	});

	test("anonymous (no identity) is REFUSED — fail closed", async () => {
		// A missing identity is never granted access. (Previously it returned a
		// non-super-admin user carrying whatever org the header asserted — the
		// multi-tenant hole.)
		expect(resolveCallerUser(db, { organisationId: ORG_A })).rejects.toThrow(
			/caller identity.*missing/,
		);
	});

	test("an EMPTY identity is REFUSED — never the system caller", async () => {
		// A blank header value (an env var that expanded to "", or a literal
		// `x-caller-user-id:` with nothing after it) must NOT inherit the system
		// caller's cross-org access. `!""` is true, so it is refused exactly like
		// a missing identity rather than resolving to the "system" sentinel.
		expect(
			resolveCallerUser(db, { userId: "", organisationId: ORG_A }),
		).rejects.toThrow(/caller identity.*missing/);
	});

	test("a literal placeholder identity is REFUSED (unknown user)", async () => {
		// An unexpanded `${...}` header (a misconfigured forwarder) is a
		// non-empty string: not the "system" sentinel, not falsy. It reaches the
		// user lookup, finds no row, and is refused as unknown — never treated as
		// a valid caller. Anything a receiver cannot derive must fail closed.
		expect(
			resolveCallerUser(db, {
				userId: "${X_USER_ID}",
				organisationId: ORG_A,
			}),
		).rejects.toThrow(/unknown caller user/);
	});

	test("a named caller whose stored role is null is NOT super-admin", async () => {
		// role is nullable (default "user"); a null role must not accidentally
		// read as privileged.
		const nullRoleDb = mockDb({ [DIAH]: null }, { [DIAH]: [ORG_A] });
		const u = await resolveCallerUser(nullRoleDb, { userId: DIAH });
		expect(u.isSuperAdmin).toBe(false);
		expect(u.organisationId).toBe(ORG_A);
	});

	test("a named caller with no membership at all resolves to no org (refused downstream)", async () => {
		// Valid user row, but no member rows anywhere → own-membership resolves
		// undefined. resolveCallerUser returns null org + not-super-admin; the
		// generated protectedProcedure then refuses on "no org, not super-admin".
		const noMembershipDb = mockDb({ [DIAH]: "user" }, {});
		const u = await resolveCallerUser(noMembershipDb, { userId: DIAH });
		expect(u.isSuperAdmin).toBe(false);
		expect(u.organisationId).toBe(null);
	});
});
