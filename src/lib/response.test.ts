// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	normalizeJsonResponse,
	truncateLargeResponse,
} from "./response.ts";

// A string comfortably over the 50KB truncation threshold.
const OVERSIZE = "x".repeat(60 * 1024);

describe("truncateLargeResponse — DATA-array safeguard preserved", () => {
	test("normalizes database bigint values before transport serialization", () => {
		const out = normalizeJsonResponse({
			id: 42n,
			done: 3n,
			total: 5n,
		}) as Record<string, unknown>;
		expect(out).toEqual({ id: "42", done: "3", total: "5" });
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	test("the truncation boundary returns bigint-free data", () => {
		const out = truncateLargeResponse({ success: true, data: [{ id: 1n }] });
		expect(out).toEqual({ success: true, data: [{ id: "1" }] });
		expect(() => JSON.stringify(out)).not.toThrow();
	});

	test("an OVERSIZE DATA array is still paginated", () => {
		// 500 small non-message records whose COLLECTIVE size exceeds the cap
		// (each item individually fits) → the safeguard must truncate.
		const bigData = Array.from({ length: 500 }, (_, i) => ({
			id: i,
			blob: "x".repeat(200),
		}));
		const wrapped = { success: true, data: bigData };
		const out = truncateLargeResponse(wrapped) as Record<string, unknown>;
		expect(out._truncated).toBeDefined();
		expect((out.data as unknown[]).length).toBeLessThan(bigData.length);
	});

	test("a small result is returned unchanged", () => {
		const small = { success: true, data: [{ id: 1, name: "x" }] };
		expect(truncateLargeResponse(small)).toEqual(small);
	});

	// THE CEILING HOLDS FOR SHAPES WITH NO ARRAY TO PAGINATE. Both earlier
	// branches look for an array; a single wide ROW matches neither, and the
	// function used to measure the overage and then return the value anyway.
	// Measured 2026-09-12: a PA agent hit exactly this shape, 9.5MB reached the
	// model, and the engine refused the turn with "The prompt is too long:
	// 1496271" — the agent produced no answer at all. Cutting its tool list from
	// 15 to 4 made it WORSE, which is the tell that no caller-side selection can
	// substitute for the bound.
	test("a large single object is bounded, not passed through", () => {
		const fat = { success: true, data: { id: 1, body: "x".repeat(2 * 1024 * 1024) } };
		const out = truncateLargeResponse(fat);
		expect(JSON.stringify(out).length).toBeLessThanOrEqual(20 * 1024);
	});

	// A shape that cannot be reduced at all still may not exceed the ceiling:
	// many distinct keys, none individually oversized, no array anywhere.
	test("an irreducible oversized result is withheld with a reason", () => {
		const wide: Record<string, string> = {};
		for (let i = 0; i < 40_000; i++) wide[`k${i}`] = `v${i}`;
		const out = truncateLargeResponse(wide) as Record<string, unknown>;
		expect(JSON.stringify(out).length).toBeLessThanOrEqual(20 * 1024);
		expect(out._oversized).toBeDefined();
	});

	// The bound is on BYTES, not rows. `take` limits rows; one row carrying a
	// fat column still blows the budget, which is why row-count truncation is
	// necessary and not sufficient.
	test("one oversized row inside an array is bounded too", () => {
		const out = truncateLargeResponse({
			success: true,
			data: [{ id: 1, transcript: "x".repeat(5 * 1024 * 1024) }],
		});
		expect(JSON.stringify(out).length).toBeLessThanOrEqual(20 * 1024);
	});
});
