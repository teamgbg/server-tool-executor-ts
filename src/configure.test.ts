// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { getPrisma } from "./configure.ts";

describe("configure() prisma injection", () => {
	test("getPrisma still refuses loudly when unconfigured", () => {
		expect(() => getPrisma()).toThrow("prisma provider not configured");
	});
});
