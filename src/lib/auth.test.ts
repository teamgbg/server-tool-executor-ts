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
import { validateAuth } from "./auth";
import type { ExecutionContext } from "./types";

configure({
	logger: {
		info() {},
		warn() {},
		error() {},
		debug() {},
	} as never,
});

const ORG = "5b742740-0f37-494c-a059-d8399ae4b350";

describe("validateAuth bypass consistency", () => {
	test("the system caller bypasses WITHOUT an org (consistent with injectScopeFilter)", () => {
		// Regression (defect 2): a system caller with no org previously threw
		// "X-Organisation-Id header is missing" here while injectScopeFilter
		// bypassed it — honoured for presence, dropped for filtering. Both
		// layers must bypass the system caller identically.
		const ctx = { userId: "system" } as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "list")).not.toThrow();
		expect(() => validateAuth("user", ctx, "work_items", "create")).not.toThrow();
	});

	test("an admin caller bypasses WITHOUT an org", () => {
		const ctx = { isAdmin: true } as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "list")).not.toThrow();
	});

	test("public scope never requires identity", () => {
		expect(() =>
			validateAuth("public", {} as ExecutionContext, "m", "list"),
		).not.toThrow();
	});
});

describe("validateAuth fails closed for non-system callers", () => {
	test("an anonymous caller (no user id) with NO org is REFUSED", () => {
		// Defect 1: `!userId` previously made this the system caller → bypass.
		// An anonymous caller asserting no org must be refused, never cross-org.
		const ctx = {} as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "list")).toThrow(
			/X-Organisation-Id/,
		);
	});

	test("an anonymous caller WITH an org passes (org-scoped, not cross-org)", () => {
		const ctx = { organisationId: ORG } as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "list")).not.toThrow();
	});

	test("a real per-org user with no org is REFUSED", () => {
		const ctx = { userId: "user-123" } as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "list")).toThrow(
			/X-Organisation-Id/,
		);
	});

	test("a write by a real user with no userId is REFUSED", () => {
		const ctx = { organisationId: ORG } as ExecutionContext;
		expect(() => validateAuth("org", ctx, "work_items", "create")).toThrow(
			/X-User-Id/,
		);
	});
});
