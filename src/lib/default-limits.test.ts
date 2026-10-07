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
	applyDefaultLimits,
	addPaginationHint,
	DEFAULT_TAKE,
	DEFAULT_FIELDS,
} from "./default-limits";

describe("applyDefaultLimits", () => {
	test("list without take gets default take + signals defaultsApplied", () => {
		const { args, defaultsApplied, defaultTake } = applyDefaultLimits({ action: "list" }, "list");
		expect(args.take).toBe(DEFAULT_TAKE);
		expect(defaultsApplied).toBe(true);
		expect(defaultTake).toBe(DEFAULT_TAKE);
	});

	test("list without fields gets default fields", () => {
		const { args } = applyDefaultLimits({ action: "list" }, "list", [
			"id",
			"slug",
			"label",
			"status",
			"is_active",
			"created_at",
			"updated_at",
		]);
		expect(Array.isArray(args.fields)).toBe(true);
		expect((args.fields as string[]).length).toBeGreaterThan(0);
	});

	test("list with explicit take is not overridden + no defaultsApplied", () => {
		const { args, defaultsApplied, defaultTake } = applyDefaultLimits({ action: "list", take: 5 }, "list");
		expect(args.take).toBe(5);
		expect(defaultsApplied).toBe(false);
		expect(defaultTake).toBe(null);
	});

	test("list with explicit fields is not overridden", () => {
		const { args } = applyDefaultLimits(
			{ action: "list", fields: ["id", "title"] },
			"list",
		);
		expect(args.fields).toEqual(["id", "title"]);
	});

	test("findMany gets defaults too", () => {
		const { args, defaultsApplied } = applyDefaultLimits({}, "findMany");
		expect(args.take).toBe(DEFAULT_TAKE);
		expect(defaultsApplied).toBe(true);
	});

	test("get/findUnique does NOT get defaults (single record)", () => {
		const { args, defaultsApplied } = applyDefaultLimits({ id: "123" }, "get");
		expect(args.take).toBeUndefined();
		expect(args.fields).toBeUndefined();
		expect(defaultsApplied).toBe(false);
	});

	test("fields filtered to model's available columns", () => {
		const { args } = applyDefaultLimits({}, "list", [
			"id",
			"slug",
			"label",
			"config",
			"is_active",
		]);
		expect(args.fields).toEqual(["id", "slug", "label", "is_active"]);
		expect((args.fields as string[]).includes("config")).toBe(false);
		expect((args.fields as string[]).includes("title")).toBe(false);
	});

	// REGRESSION, 2026-08-08. `work_items` is keyed by id/title/kind and has NO
	// slug, label or name. Prisma REJECTS an unknown key in `select` rather than
	// ignoring it, so injecting the unfiltered DEFAULT_FIELDS made every
	// `work_items` list call fail with "Unknown field `slug` for select
	// statement on model `work_items`" — for ANY argument shape, since the
	// default is merged whether `fields` is absent or supplied. The model was
	// unlistable for every caller.
	//
	// This is the fixture the previous behaviour could not pass. It asserts the
	// SURVIVING columns, not merely the absence of `slug`: a projection that
	// filtered everything away would satisfy a negative-only assertion while
	// returning nothing useful.
	test("a model without slug/label/name still gets a usable projection", () => {
		const { args } = applyDefaultLimits({}, "list", [
			"id",
			"title",
			"kind",
			"parent_id",
			"status",
			"created_at",
			"updated_at",
		]);
		expect(args.fields).toEqual(["id", "title", "status", "created_at", "updated_at"]);
		for (const absent of ["slug", "label", "name"]) {
			expect((args.fields as string[]).includes(absent)).toBe(false);
		}
	});

	// Without model info we must NOT guess. The old branch injected every
	// DEFAULT_FIELD on the premise that "the DB ignores unknown columns", which
	// is false for Prisma — so the guess guaranteed failure instead of
	// degrading. Leaving `fields` unset lets the caller's own "fields is
	// required" check raise a message that names the fix.
	test("without availableFields, no projection is guessed", () => {
		const { args, defaultsApplied } = applyDefaultLimits({}, "list");
		expect(args.fields).toBeUndefined();
		// The take budget still applies — it is model-independent.
		expect(args.take).toBe(DEFAULT_TAKE);
		expect(defaultsApplied).toBe(true);
	});

	test("null values are treated as omitted", () => {
		const { args, defaultsApplied } = applyDefaultLimits({ take: null, fields: null }, "list", [
			"id",
			"slug",
			"status",
		]);
		expect(args.take).toBe(DEFAULT_TAKE);
		expect(args.fields).toEqual(["id", "slug", "status"]);
		expect(defaultsApplied).toBe(true);
	});

	test("create/update/delete do NOT get defaults", () => {
		const { args, defaultsApplied } = applyDefaultLimits({ title: "test" }, "create");
		expect(args.take).toBeUndefined();
		expect(args.fields).toBeUndefined();
		expect(defaultsApplied).toBe(false);
	});
});

describe("addPaginationHint", () => {
	test("wraps bare array with items + _pagination", () => {
		const data = [{ id: "1" }, { id: "2" }, { id: "3" }];
		const result = addPaginationHint(data, 20, 100) as { items: unknown[]; _pagination: { returned: number; total: number; has_more: boolean; hint: string } };
		expect(result.items).toEqual(data);
		expect(result._pagination.returned).toBe(3);
		expect(result._pagination.total).toBe(100);
		expect(result._pagination.has_more).toBe(true);
		expect(result._pagination.hint).toContain("skip");
	});

	test("wraps ORPC response { success, data: [...] }", () => {
		const result = addPaginationHint({ success: true, data: [{ id: "1" }] }, 20, 5) as { _pagination: { has_more: boolean } };
		expect(result._pagination.has_more).toBe(false);
		expect(result._pagination.returned).toBe(1);
	});

	test("does NOT double-wrap if _pagination already exists", () => {
		const alreadyWrapped = { success: true, data: [], _pagination: { returned: 0 } };
		const result = addPaginationHint(alreadyWrapped, 20, 100);
		expect(result).toBe(alreadyWrapped);
	});

	test("empty array returns as-is (no hint on empty)", () => {
		const result = addPaginationHint([], 20, 0);
		expect(result).toEqual([]);
	});

	test("non-array result passes through unchanged", () => {
		const obj = { id: "1", title: "single" };
		const result = addPaginationHint(obj, 20, 1);
		expect(result).toBe(obj);
	});

	test("total null when not provided", () => {
		const result = addPaginationHint([{ id: "1" }], 20) as { _pagination: { total: null; has_more: null } };
		expect(result._pagination.total).toBe(null);
		expect(result._pagination.has_more).toBe(null);
	});
});
