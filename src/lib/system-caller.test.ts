// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { isSystemCaller, SYSTEM_USER_ID } from "./system-caller";

describe("isSystemCaller", () => {
	test("the explicit 'system' sentinel is the system caller", () => {
		expect(isSystemCaller(SYSTEM_USER_ID)).toBe(true);
		expect(isSystemCaller("system")).toBe(true);
	});

	test("a MISSING identity is NOT the system caller (anonymous → fail closed)", () => {
		// Regression: `!userId` previously made these TRUE, granting an
		// anonymous caller full cross-org access. They must stay FALSE so an
		// anonymous caller (no X-User-Id, e.g. the gateway-forwarded fleet
		// path) is org-scoped or refused — never silently super-admin.
		expect(isSystemCaller(undefined)).toBe(false);
		expect(isSystemCaller("")).toBe(false);
	});

	test("a real per-org user id is NOT a system caller (stays org-scoped)", () => {
		expect(isSystemCaller("user-123")).toBe(false);
		expect(isSystemCaller("5b742740-0f37-494c-a059-d8399ae4b350")).toBe(false);
	});

	test("the sentinel value is the literal 'system'", () => {
		expect(SYSTEM_USER_ID).toBe("system");
	});
});
