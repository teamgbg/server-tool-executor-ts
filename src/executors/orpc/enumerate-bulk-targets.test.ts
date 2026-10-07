// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { enumerateBulkTargets } from "./enumerate-bulk-targets.ts";

function makePrisma(rows: Array<Record<string, unknown>>) {
	return {
		work_items: {
			findMany: async (args: { take?: number }) =>
				rows.slice(0, args?.take ?? rows.length),
		},
	} as never;
}

describe("enumerateBulkTargets", () => {
	test("enumerates the matched key-field identities", async () => {
		const rows = [
			{ id: "row-1" },
			{ id: "row-2" },
			{ id: "row-3" },
		];
		const result = await enumerateBulkTargets(
			makePrisma(rows),
			"work_items",
			{ status: "pending" },
			["id"],
		);
		expect(result).toEqual({
			affected: rows,
			affected_truncated: false,
		});
	});

	test("caps the enumeration at 200 identities and names the truncation", async () => {
		const rows = Array.from({ length: 250 }, (_, i) => ({ id: `row-${i}` }));
		const result = await enumerateBulkTargets(
			makePrisma(rows),
			"work_items",
			{},
			["id"],
		);
		expect(result.affected).toHaveLength(200);
		expect(result.affected[0]).toEqual({ id: "row-0" });
		expect(result.affected_truncated).toBe(true);
	});

	test("selects exactly the composite key fields", async () => {
		let seenSelect: unknown;
		const prisma = {
			codegen_output_type_deps: {
				findMany: async (args: { select?: unknown }) => {
					seenSelect = args?.select;
					return [{ slug: "s", dep_type: "d" }];
				},
			},
		} as never;
		await enumerateBulkTargets(
			prisma,
			"codegen_output_type_deps",
			{ slug: "s" },
			["slug", "dep_type"],
		);
		expect(seenSelect).toEqual({ slug: true, dep_type: true });
	});

	test("fails soft when the model delegate is absent — the mutation errors loud at its own boundary", async () => {
		const result = await enumerateBulkTargets(
			{} as never,
			"no_such_model",
			{},
			["id"],
		);
		expect(result).toEqual({ affected: [], affected_truncated: false });
	});
});
