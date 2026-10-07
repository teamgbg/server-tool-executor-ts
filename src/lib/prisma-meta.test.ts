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
import { getJsonFieldNames, getModelFields, modelHasField } from "./prisma-meta.ts";

// Minimal stand-in for a Prisma 7 client: the runtime datamodel shape the cache
// reads (models keyed by name, each carrying a fields[] of DMMF field objects).
// Scalar fields carry `type` (the Prisma scalar type name) + `kind:"scalar"`.
const fakeClient = {
	_runtimeDataModel: {
		models: {
			proposals: {
				fields: [
					{ name: "id", type: "String", kind: "scalar" },
					{ name: "organisation_id", type: "String", kind: "scalar" },
					{ name: "created_by", type: "String", kind: "scalar" },
					{ name: "page_id", type: "String", kind: "scalar" },
				],
			},
			proposal_sections: {
				fields: [
					{ name: "id", type: "String", kind: "scalar" },
					{ name: "proposal_id", type: "String", kind: "scalar" },
				],
			},
			// Mirrors organisation_profile: Json columns of both shapes alongside
			// relation fields, used to verify Json-field detection.
			organisation_profile: {
				fields: [
					{ name: "id", type: "String", kind: "scalar" },
					{ name: "company_name", type: "String", kind: "scalar" },
					{ name: "values", type: "Json", kind: "scalar" },
					{ name: "subscription", type: "Json", kind: "scalar" },
					{ name: "business_descriptions", type: "Json", kind: "scalar" },
					{ name: "organisation_id", type: "String", kind: "scalar" },
					{ name: "plans", type: "plans", kind: "object" },
				],
			},
		},
	},
};

configure({ getPrisma: () => fakeClient });

describe("prisma-meta runtime datamodel introspection", () => {
	test("does not throw (regression: bare `Prisma` ReferenceError)", () => {
		expect(() => modelHasField("proposals", "id")).not.toThrow();
	});

	test("reads field presence from the injected client datamodel", () => {
		expect(modelHasField("proposals", "organisation_id")).toBe(true);
		expect(modelHasField("proposals", "created_by")).toBe(true);
		expect(modelHasField("proposals", "page_id")).toBe(true);
		expect(modelHasField("proposals", "nonexistent_col")).toBe(false);
		expect(modelHasField("unknown_model", "id")).toBe(false);
	});

	test("getModelFields returns the full field set for a model", () => {
		expect([...getModelFields("proposal_sections")].sort()).toEqual([
			"id",
			"proposal_id",
		]);
		expect(getModelFields("unknown_model").size).toBe(0);
	});

	test("getJsonFieldNames returns only scalar Json fields, not relations or other scalars", () => {
		expect([...getJsonFieldNames("organisation_profile")].sort()).toEqual([
			"business_descriptions",
			"subscription",
			"values",
		]);
		// A relation whose type is a model name ("plans") must NOT be misread as
		// a Json field, and plain String scalars are excluded.
		expect(getJsonFieldNames("organisation_profile").has("plans")).toBe(false);
		expect(getJsonFieldNames("organisation_profile").has("company_name")).toBe(
			false,
		);
		// A model with no Json columns yields an empty set, not undefined.
		expect(getJsonFieldNames("proposal_sections").size).toBe(0);
		expect(getJsonFieldNames("unknown_model").size).toBe(0);
	});
});
