// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@teamscala/db/client";
import { assertProtectedUniqueWrite } from "./protected-unique-write";

describe("assertProtectedUniqueWrite", () => {
	test("checks the target through a non-unique constrained read", async () => {
		let observed: unknown;
		const prisma = {
			registry_entries: {
				findFirst: async (args: unknown) => {
					observed = args;
					return { id: "row-1" };
				},
			},
		} as unknown as PrismaClient;
		await assertProtectedUniqueWrite(
			prisma,
			"registry_entries",
			"update",
			{ where: { id: "row-1" } },
			{ type: { notIn: ["secret"] } },
		);
		expect(observed).toEqual({
			where: {
				AND: [
					{ id: "row-1" },
					{ type: { notIn: ["secret"] } },
				],
			},
			select: { id: true },
		});
	});

	test("refuses a target outside the protected subtype boundary", async () => {
		const prisma = {
			registry_entries: { findFirst: async () => null },
		} as unknown as PrismaClient;
		await expect(
			assertProtectedUniqueWrite(
				prisma,
				"registry_entries",
				"delete",
				{ where: { id: "secret-row" } },
				{ type: { notIn: ["secret"] } },
			),
		).rejects.toThrow(/another capability/);
	});
});
