// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { registerDb8, getDb8 } from "@teamscala/db/db8-registry";
import { resolveModelOrm } from "@teamscala/db/orm-adapter/model-orm";

/** Minimal stand-in with the only shape resolveModelOrm reads. */
const fakeDb8 = { orm: { public: { RegistryEntries: {} } } };

describe("the db8 the context carries satisfies the procedures that consume it", () => {
	test("an absent client is exactly what resolveModelOrm refuses", () => {
		expect(() => resolveModelOrm(undefined)).toThrow(/v8 client/);
	});

	test("what getDb8 returns after registration is accepted by resolveModelOrm", () => {
		registerDb8(fakeDb8 as never);
		const fromRegistry = getDb8() ?? undefined;
		expect(fromRegistry).toBeDefined();
		// The assertion that matters: the value the caller context puts on
		// ctx.db8 is one resolveModelOrm accepts. If either side changes its
		// expected shape, this fails instead of every tool failing in prod.
		expect(() => resolveModelOrm(fromRegistry)).not.toThrow();
	});

	test("the resolved orm is model-indexed, which is what generated procedures index", () => {
		registerDb8(fakeDb8 as never);
		const orm = resolveModelOrm(getDb8() ?? undefined);
		// Generated procedures do resolveModelOrm(ctx.db8)["<Model>"] — so the
		// return must be indexable per model rather than a bare client.
		expect(orm.RegistryEntries).toBeDefined();
	});
});
