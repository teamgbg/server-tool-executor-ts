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
import {
	buildCreateData,
	buildUpdateArgs,
	buildFindManyArgs,
	organisationValueOrRefuse,
} from "./orpc-args.ts";
import {
	buildStrictBulkMutationArgs,
	isObjectWithKeys,
} from "./orpc-bulk-gate.ts";
import { liftRemainingColumnFilters } from "./orpc-args-where.ts";

// Stand-in Prisma client: organisation_profile with its real Json columns.
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
						{ name: "business_descriptions", type: "Json", kind: "scalar" },
					],
				},
			},
		},
	}),
});

const publicConfig: Record<string, unknown> = { executor_key: "orpc", scopeType: "public" };
const ctx = {};

describe("buildUpdateArgs — identity-in-data refusal", () => {
	// 2026-08-20, measured on the builda_pages generated tool: a caller
	// wrapping the row id inside `data` produced where:{} + data.id (an
	// attempted primary-key write) and died at Prisma with a foreign echo.
	// The guard refuses BEFORE any arg building, naming both working shapes.
	const idConfig = {
		...publicConfig,
		executor_key: "orpc" as const,
		autoTransformUpdate: true,
		identifierField: "id",
		flatFilterFields: ["id"],
	};

	test("refuses an id wrapped inside data with both working shapes named", () => {
		expect(() =>
			buildUpdateArgs(
				{ data: { values: [], id: "abc" } },
				idConfig,
				ctx,
				"organisation_profile",
			),
		).toThrow(/identity field.*cannot go inside `data`/s);
	});

	test("refuses id inside data even when where is also present", () => {
		expect(() =>
			buildUpdateArgs(
				{ where: { id: "abc" }, data: { values: [], id: "abc" } },
				idConfig,
				ctx,
				"organisation_profile",
			),
		).toThrow(/identity field.*cannot go inside `data`/s);
	});

	test("clean shape still works: id top-level + data", () => {
		const args = buildUpdateArgs(
			{ id: "abc", data: { company_name: "Acme" } },
			idConfig,
			ctx,
			"organisation_profile",
		);
		expect(args.where).toEqual({ id: "abc" });
		expect(args.data).toEqual({ company_name: "Acme" });
	});
});

describe("buildFindManyArgs — searchFields use CONTAINS on the read path", () => {
	const configWithSearchFields = {
		...publicConfig,
		executor_key: "orpc" as const,
		flatFilterFields: ["status"],
		searchFields: ["title", "description", "group_label"],
		identifierField: "id",
	};

	test("searchFields are applied as case-insensitive contains (partial match)", () => {
		// list{title:'Streaming-Indicator'} must find a row titled
		// 'Streaming-Indicator: …' — exact eq would return 0.
		const args = buildFindManyArgs(
			{ title: "Streaming-Indicator", description: "Fix indicator" },
			configWithSearchFields,
			ctx,
		);
		expect(args.where).toEqual({
			title: { contains: "Streaming-Indicator", mode: "insensitive" },
			description: { contains: "Fix indicator", mode: "insensitive" },
		});
	});

	test("flatFilterFields stay eq, searchFields use contains", () => {
		const args = buildFindManyArgs(
			{ title: "Fix it", status: "active" },
			configWithSearchFields,
			ctx,
		);
		expect(args.where).toEqual({
			title: { contains: "Fix it", mode: "insensitive" },
			status: "active",
		});
	});

	test("searchFields not in input do not appear in where", () => {
		const args = buildFindManyArgs(
			{ status: "active" },
			configWithSearchFields,
			ctx,
		);
		expect(args.where).toEqual({ status: "active" });
	});

	test("a field in BOTH flatFilterFields and searchFields keeps eq (flat wins)", () => {
		const config = {
			...publicConfig,
			executor_key: "orpc" as const,
			flatFilterFields: ["title", "status"],
			searchFields: ["title", "description"],
			identifierField: "id",
		};
		const args = buildFindManyArgs({ title: "Fix it" }, config, ctx);
		// title is declared as a flatFilterField → eq wins over the contains searchField semantic
		expect(args.where).toEqual({ title: "Fix it" });
	});

	test("search parameter is not added to where (handled separately)", () => {
		const args = buildFindManyArgs(
			{ search: "foo", status: "active" },
			configWithSearchFields,
			ctx,
		);
		expect(args.where).toEqual({ status: "active" });
	});

	test("non-string searchField value falls back to eq (number coerced to string)", () => {
		// A non-string value (e.g. a number) can't be a substring; eq is the safe
		// fallback, with the same number→string coercion flatFilterFields use for
		// Prisma String columns.
		const config = {
			...publicConfig,
			executor_key: "orpc" as const,
			flatFilterFields: [],
			searchFields: ["count"],
			identifierField: "id",
		};
		const args = buildFindManyArgs({ count: 5 }, config, ctx);
		expect(args.where).toEqual({ count: "5" });
	});
});

describe("read vs write searchField semantics (contains on reads, eq on writes)", () => {
	// The Planner-requested guard: the SAME searchField ('title') must filter
	// with CONTAINS on the read path (findMany) so list{title:'foo'} finds
	// 'foo: …', but with eq on the write path (update_many) so destructive
	// bulk ops match exactly — never a broad substring wipe.
	const readWriteConfig = {
		...publicConfig,
		executor_key: "orpc" as const,
		flatFilterFields: ["status"],
		searchFields: ["title"],
		identifierField: "id",
	};

	test("findMany (read) uses contains for searchFields", () => {
		const args = buildFindManyArgs(
			{ title: "Streaming-Indicator" },
			readWriteConfig,
			ctx,
		);
		expect(args.where).toEqual({
			title: { contains: "Streaming-Indicator", mode: "insensitive" },
		});
	});

	test("update_many (write) uses eq for searchFields", () => {
		// buildUpdateArgs (update_many path) must NOT use contains — a substring
		// delete/update on a text column is a broad-blast footgun.
		const result = buildUpdateArgs(
			{ title: "exact-title-only", status: "closed" },
			readWriteConfig,
			ctx,
		);
		expect(result.where).toEqual({
			title: "exact-title-only",
			status: "closed",
		});
	});
});

describe("buildStrictBulkMutationArgs — the 2026-08-16 incident is unrepresentable", () => {
	// THE MEASURED FAILURE: `work_items update_many` called with flat
	// kind/title/organisation_id — read by the caller as a FILTER, consumed
	// as SET-VALUES — rewrote 6,890 titles org-wide and reported success.
	// The bulk actions now accept ONLY `where` (+ `data`); every other shape
	// is refused with the correct one named.
	test("the exact incident call is refused and the message names where/data", () => {
		expect(() =>
			buildStrictBulkMutationArgs("updateMany", {
				kind: "subtask",
				title: "capture-test-470-project",
				organisation_id: "org-1",
			}),
		).toThrow(/update_many.*where.*data/s);
	});

	test("a filtered bulk update passes through with both namespaces intact", () => {
		const result = buildStrictBulkMutationArgs("updateMany", {
			where: { status: "pending", organisation_id: "org-1" },
			data: { title: "New title" },
		});
		expect(result).toEqual({
			where: { status: "pending", organisation_id: "org-1" },
			data: { title: "New title" },
		});
	});

	test("update_many without `where` is refused even when nothing else is passed", () => {
		expect(() =>
			buildStrictBulkMutationArgs("updateMany", { data: { title: "x" } }),
		).toThrow(/requires .where./);
	});

	test("update_many without `data` is refused naming the set-namespace", () => {
		expect(() =>
			buildStrictBulkMutationArgs("updateMany", { where: { status: "pending" } }),
		).toThrow(/requires .data./);
	});

	test("stray top-level columns are refused and the message says where each kind goes", () => {
		expect(() =>
			buildStrictBulkMutationArgs("updateMany", {
				where: { status: "pending" },
			data: { title: "x" },
			title: "stray",
			take: 50,
		}),
		).toThrow(/received top-level title, take/);
	});

	test("delete_many requires `where` and refuses stray columns the same way", () => {
		expect(() =>
			buildStrictBulkMutationArgs("deleteMany", { source: "watchdog-e2e" }),
		).toThrow(/delete_many/);
		const result = buildStrictBulkMutationArgs("deleteMany", {
			where: { session_id: "session-1", source: "watchdog-e2e" },
		});
		expect(result).toEqual({
			where: { session_id: "session-1", source: "watchdog-e2e" },
		});
	});
});

describe("bulk deletes preserve generated top-level column filters", () => {
	test("real bulk-delete columns keep exact-match semantics inside `where`", () => {
		const where: Record<string, unknown> = {};
		liftRemainingColumnFilters(
			{ session_id: "session-1", source: "watchdog-e2e" },
			where,
			"cli_session_messages",
			"eq",
		);
		expect(where).toEqual({
			session_id: "session-1",
			source: "watchdog-e2e",
		});
	});
});

describe("buildUpdateArgs — explicit-where path keeps searchFields out of inferred data", () => {
	// On the explicit-where path (no flat identity), filter fields
	// (flatFilterFields AND searchFields) lift into `where`; a writable
	// searchable field must NOT also be inferred as data — that would
	// double-use it as both filter and value on the same statement. The
	// updateMany surface no longer routes flat args here at all (strict gate);
	// this covers the update/upsert paths that still share the branch.
	const updateManyConfig = {
		...publicConfig,
		executor_key: "orpc" as const,
		flatFilterFields: ["status"],
		searchFields: ["title"],
		identifierField: "id",
		// No autoTransformUpdate → exercises the else branch (explicit-where path).
	};

	test("searchField is lifted into where and NOT inferred as data", () => {
		const result = buildUpdateArgs(
			{ where: { id: "row-1" }, title: "X", status: "closed", notes: "n" },
			updateManyConfig,
			ctx,
		);
		expect(result.where).toEqual({
			id: "row-1",
			title: "X",
			status: "closed",
		});
		expect(result.data).toEqual({ notes: "n" });
	});

	test("a writable non-filter field is still inferred as data", () => {
		const result = buildUpdateArgs(
			{ where: { id: "row-1" }, title: "X", notes: "updated" },
			updateManyConfig,
			ctx,
		);
		expect(result.where).toEqual({ id: "row-1", title: "X" });
		expect(result.data).toEqual({ notes: "updated" });
	});
});

describe("buildFindManyArgs — top-level filters on a tool with no searchFields", () => {
	const ctx = { userId: "u1", organisationId: "org1" } as never;

	/*
	 * THE MEASURED FAILURE. client_database declares no searchFields and no
	 * flatFilterFields, so top-level filters were DROPPED: the agent called
	 * list{first_name:"Doris",last_name:"Bellissimo"}, got 20 unrelated people
	 * back starting with Darren Reddy, and answered in good faith that she did
	 * not exist — while three matching rows sat in the same org.
	 *
	 * A dropped filter never errors and returns plausible rows, so the model is
	 * made confidently wrong. Any key that is a REAL column must become a filter.
	 */
	test("lifts real model columns into where even with no searchFields declared", () => {
		const args = buildFindManyArgs(
			{ first_name: "Doris", last_name: "Bellissimo" },
			{ orgField: "organisation_id" } as never,
			ctx,
			"client_database",
		);
		const where = args.where as Record<string, unknown>;
		expect(where.first_name).toEqual({ contains: "Doris", mode: "insensitive" });
		expect(where.last_name).toEqual({ contains: "Bellissimo", mode: "insensitive" });
	});

	/*
	 * Only REAL columns are lifted. A typo must not become a filter that matches
	 * nothing, which would turn a wrong-parameter bug back into a silent
	 * empty result — the very shape this fix removes.
	 */
	/*
	 * When the DMMF HAS metadata for the model, a key that is not a column is not
	 * lifted. When it has none (as in this unit context), the key is lifted and
	 * Prisma rejects it loudly — deliberately, because dropping it would restore
	 * the silent-wrong-answer bug this fix exists to remove.
	 */
	test("lifts unknown keys when no model metadata is available, so Prisma can reject them loudly", () => {
		const args = buildFindManyArgs(
			{ some_column: "x" },
			{ orgField: "organisation_id" } as never,
			ctx,
			"client_database",
		);
		expect((args.where as Record<string, unknown>).some_column).toEqual({
			contains: "x",
			mode: "insensitive",
		});
	});
});

describe("organisationValueOrRefuse — an unexpanded template org never reaches a write", () => {
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
							{ name: "business_descriptions", type: "Json", kind: "scalar" },
						],
					},
					work_items: {
						fields: [
							{ name: "id", type: "String", kind: "scalar" },
							{ name: "title", type: "String", kind: "scalar" },
							{ name: "organisation_id", type: "String", kind: "scalar" },
						],
					},
				},
			},
		}),
	});

	const config = {
		scopeType: "org",
		skipOrgInjectOnCreate: false,
		orgField: "organisation_id",
	} as never;

	test("refuses a context organisation that is still an env template", () => {
		expect(() =>
			buildCreateData(
				{ title: "x" },
				config,
				{ organisationId: "${MCP_SYSTEM_ORG_ID}" } as never,
				"work_items",
			),
		).toThrow(/unexpanded env template '.+MCP_SYSTEM_ORG_ID.+'/);
	});

	test("refuses a caller-supplied org that is still an env template", () => {
		expect(() =>
			buildCreateData(
				{ title: "x", organisation_id: "${MCP_SYSTEM_ORG_ID}" },
				config,
				{ organisationId: "real-org" } as never,
				"work_items",
			),
		).toThrow(/Refusing write/);
	});

	test("a real context org is still injected when the caller omits it", () => {
		const { data } = buildCreateData(
			{ title: "x" },
			config,
			{ organisationId: "real-org" } as never,
			"work_items",
		);
		expect((data as Record<string, unknown>).organisation_id).toBe("real-org");
	});
});
