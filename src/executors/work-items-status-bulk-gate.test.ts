// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";

import { statusOnlyBulkGateRefusal } from "./work-items-status-bulk-gate";

describe("statusOnlyBulkGateRefusal", () => {
	/** THE MEASURED INCIDENT (2026-08-24 04:41:55Z): status-only where, no
	 * cap — 515 rows matched platform-wide. Must refuse naming the count and
	 * the remedy, never pass. */
	test("the incident shape refuses with the count and the remedy", () => {
		const refusal = statusOnlyBulkGateRefusal({
			where: { status: "todo" },
			matched: 515,
		});
		expect(refusal).toBeString();
		expect(refusal).toContain("515");
		expect(refusal).toContain("max_affected_rows");
		expect(refusal).toContain("parent_id");
	});

	/** A status-only write WITH a counted cap at or above the match passes —
	 * the gate bounds blast radius, it does not ban bulk writes. */
	test("a counted cap admits the status-only write", () => {
		expect(
			statusOnlyBulkGateRefusal({ where: { status: "todo" }, matched: 5, maxAffectedRows: 5 }),
		).toBeNull();
		expect(
			statusOnlyBulkGateRefusal({ where: { status: "todo" }, matched: 5, maxAffectedRows: 8 }),
		).toBeNull();
	});

	/** A cap BELOW the match refuses — the declared radius was wrong. */
	test("an undersized cap refuses", () => {
		const refusal = statusOnlyBulkGateRefusal({
			where: { status: "todo" },
			matched: 515,
			maxAffectedRows: 5,
		});
		expect(refusal).toContain("exceeding declared max_affected_rows=5");
	});

	/** A SCOPED where (parent_id, or any second key) never pays the gate —
	 * scoping the filter is the remedy, so it must not itself be refused. */
	test("a scoped where bypasses the gate entirely", () => {
		expect(
			statusOnlyBulkGateRefusal({ where: { parent_id: "p-1", status: "todo" }, matched: 515 }),
		).toBeNull();
		expect(
			statusOnlyBulkGateRefusal({ where: { parent_id: "p-1" }, matched: 515 }),
		).toBeNull();
	});

	/** No where at all (undefined) is not this gate's shape. */
	test("an absent where passes through", () => {
		expect(statusOnlyBulkGateRefusal({ matched: 515 })).toBeNull();
	});

	/** The cap must be a real integer — stringified or fractional caps are
	 * refusals, not silently accepted (numbers stay numbers). */
	test("a malformed cap is a refusal", () => {
		expect(
			statusOnlyBulkGateRefusal({ where: { status: "todo" }, matched: 3, maxAffectedRows: "5" }),
		).toBeString();
		expect(
			statusOnlyBulkGateRefusal({ where: { status: "todo" }, matched: 3, maxAffectedRows: 2.5 }),
		).toBeString();
		expect(
			statusOnlyBulkGateRefusal({ where: { status: "todo" }, matched: 3, maxAffectedRows: 0 }),
		).toBeString();
	});
});
