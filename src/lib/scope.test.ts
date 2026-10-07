// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { configure } from "../configure.ts";
import { injectScopeFilter } from "./scope";
import type { ExecutionContext, OrpcExecutorConfig } from "./types";

configure({
	logger: {
		info() {},
		warn() {},
		error() {},
		debug() {},
	} as never,
});

const SYSTEM_ORG = "c503629a-85d9-4d25-9431-f6fa59504868";
const REAL_ORG = "5b742740-0f37-494c-a059-d8399ae4b350";
const orgConfig = { scopeType: "org" } as unknown as OrpcExecutorConfig;

describe("injectScopeFilter system-caller bypass", () => {
	test("system sentinel caller: no organisation_id stamped (full cross-org)", () => {
		const where: Record<string, unknown> = {};
		const ctx = {
			userId: "system",
			organisationId: SYSTEM_ORG,
		} as ExecutionContext;
		injectScopeFilter(where, orgConfig, ctx);
		expect(where.organisation_id).toBeUndefined();
	});

	test("anonymous caller (no user id) WITH an org: organisation_id IS stamped (fails closed to the org, not cross-org)", () => {
		// Regression: `!userId` previously made an anonymous caller the system
		// caller, so this stamped NOTHING and the caller saw every org. A
		// missing identity must be scoped to the org it asserts (or refused by
		// validateAuth when it asserts none) — never granted cross-org access.
		const where: Record<string, unknown> = {};
		const ctx = { organisationId: SYSTEM_ORG } as ExecutionContext;
		injectScopeFilter(where, orgConfig, ctx);
		expect(where.organisation_id).toBe(SYSTEM_ORG);
	});

	test("real per-org user: organisation_id IS stamped (stays scoped)", () => {
		const where: Record<string, unknown> = {};
		const ctx = {
			userId: "user-123",
			organisationId: REAL_ORG,
		} as ExecutionContext;
		injectScopeFilter(where, orgConfig, ctx);
		expect(where.organisation_id).toBe(REAL_ORG);
	});
});
