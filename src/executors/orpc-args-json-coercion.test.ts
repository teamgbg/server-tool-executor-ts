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
import type { ExecutionContext, OrpcExecutorConfig } from "../lib/types.ts";
import { buildCreateData, buildUpdateArgs } from "./orpc-args.ts";

configure({
	getPrisma: () => ({
		_runtimeDataModel: {
			models: {
				organisation_profile: {
					fields: [
						{ name: "id", type: "String", kind: "scalar" },
						{ name: "company_name", type: "String", kind: "scalar" },
						{ name: "values", type: "Json", kind: "scalar" },
						{ name: "subscription", type: "Json", kind: "scalar" },
					],
				},
			},
		},
	}),
});

const publicConfig: OrpcExecutorConfig = {
	executor_key: "orpc",
	scopeType: "public",
};
const ctx = {} as ExecutionContext;

describe("buildCreateData — Json-column string coercion", () => {
	test("parses stringified arrays and objects for Json columns", () => {
		const data = buildCreateData(
			{ company_name: "Acme", values: "[]", subscription: '{"plan":"pro"}' },
			publicConfig,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(data.values).toEqual([]);
		expect(data.subscription).toEqual({ plan: "pro" });
	});

	test("leaves real Json values and non-JSON strings untouched", () => {
		const real = buildCreateData(
			{ values: [{ vision: "x" }], subscription: { plan: "pro" } },
			publicConfig,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(real.values).toEqual([{ vision: "x" }]);
		expect(real.subscription).toEqual({ plan: "pro" });

		const scalar = buildCreateData(
			{ values: "not-json" },
			publicConfig,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(scalar.values).toBe("not-json");
	});

	test("does not parse JSON-shaped strings for String columns", () => {
		const data = buildCreateData(
			{ company_name: '{"not":"parsed"}' },
			publicConfig,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(data.company_name).toBe('{"not":"parsed"}');
	});

	test("does not inject an omitted Json field", () => {
		const data = buildCreateData(
			{ company_name: "Acme" },
			publicConfig,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(data.values).toBeUndefined();
	});
});

describe("buildUpdateArgs — Json-column string coercion", () => {
	test("parses Json strings and leaves String columns untouched", () => {
		const config = {
			...publicConfig,
			autoTransformUpdate: true,
			identifierField: "id",
		};
		const parsed = buildUpdateArgs(
			{ id: "abc", values: "[1,2,3]" },
			config,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(parsed.values).toEqual([1, 2, 3]);

		const untouched = buildUpdateArgs(
			{ id: "abc", company_name: '{"x":1}' },
			config,
			ctx,
			"organisation_profile",
		).data as Record<string, unknown>;
		expect(untouched.company_name).toBe('{"x":1}');
	});
});
