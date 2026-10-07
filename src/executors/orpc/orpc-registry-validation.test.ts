// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, mock, test } from "bun:test";

mock.module("@teamscala/db/registry/load-config", () => ({
	loadRegistryConfig: async () => ({ platformOrganisationId: "organisation-id" }),
}));
mock.module("@teamscala/db-validation/validate-row", () => ({
	validateRow: (type: string, config: Record<string, unknown>) => {
		if (type === "agent_invocation" && !("agent_id" in config)) {
			throw new Error("agent_invocation requires agent_id");
		}
		return config;
	},
}));

const { validateRegistryConfig } = await import("./orpc-registry-validation.ts");

describe("validateRegistryConfig", () => {
	test("resolves type and slug before validating an id-addressed update", async () => {
		let existingRowReads = 0;
		const prisma = {
			registry_entries: {
				findFirst: async () => {
					existingRowReads += 1;
					return { type: "agent_invocation", slug: "fleet-supervisor-turn-check" };
				},
			},
			registry_config_schemas: {
				findFirst: async () => ({
					schema: {
						type: "object",
						required: ["agent_id"],
						properties: { agent_id: { type: "string" } },
					},
				}),
			},
			audit_trail: { create: async () => ({ id: "audit" }) },
		};

		await expect(
			validateRegistryConfig(
				"update",
				{ where: { id: "row-id" }, data: { config: { identity: {} } } },
				prisma as never,
				{} as never,
			),
		).rejects.toThrow("agent_invocation requires agent_id");
		expect(existingRowReads).toBe(1);
	});
});
