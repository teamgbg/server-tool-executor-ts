// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import type { ExecutionContext, OrpcExecutorConfig } from "#tool-executor/lib/types.ts";
import { configure } from "#tool-executor/configure.ts";
import { prepareArgs } from "./prepare-args";
import { buildFinalArgsByMethod } from "./final-args-by-method";

const context: ExecutionContext = {
	userId: "system",
	isAdmin: true,
};

configure({
	getPrisma: () => ({
		_runtimeDataModel: {
			models: {
				codegen_output_type_deps: { fields: [{ name: "slug", type: "String", kind: "scalar" }, { name: "dep_type", type: "String", kind: "scalar" }, { name: "output_type", type: "String", kind: "scalar" }, { name: "enabled", type: "Boolean", kind: "scalar" }] },
			},
		},
	}),
});

describe("buildFinalArgsByMethod findFirst", () => {
	test("preserves a schema-exposed path filter omitted from curated filter lists", () => {
		const config: OrpcExecutorConfig = {
			executor_key: "orpc",
			scopeType: "public",
			idField: "id",
			flatFilterFields: ["id"],
		};

		const result = buildFinalArgsByMethod(
			"findFirst",
			"scala_docs_files",
			{ path: "scala-os/telemetry.md" },
			["id", "path", "content"],
			config,
			context,
		);

		expect(result).toEqual({
			where: {
				path: { contains: "scala-os/telemetry.md", mode: "insensitive" },
			},
			select: { id: true, path: true, content: true },
		});
	});

	test("fails loud by forwarding an unknown key when model metadata is unavailable", () => {
		const config: OrpcExecutorConfig = {
			executor_key: "orpc",
			scopeType: "public",
			idField: "id",
			flatFilterFields: ["id"],
		};

		const result = buildFinalArgsByMethod(
			"findFirst",
			"scala_docs_files",
			{ not_a_docs_column: "ignored" },
			["id", "path"],
			config,
			context,
		);

		expect(result).toEqual({
			where: {
				not_a_docs_column: { contains: "ignored", mode: "insensitive" },
			},
			select: { id: true, path: true },
		});
	});
});

describe("buildFinalArgsByMethod update — row-address refusal", () => {
	// 2026-08-20, measured on the builda_pages generated tool: an update whose
	// identity never reached `where` arrived at Prisma as where:{} and failed
	// with Prisma's own echo. The tool must refuse first, naming both shapes.
	const config: OrpcExecutorConfig = {
		executor_key: "orpc",
		scopeType: "public",
		idField: "id",
		identifierFields: ["id"],
		flatFilterFields: ["id"],
		autoTransformUpdate: true,
	};

	test("refuses an update with no identity in where, naming both working shapes", () => {
		expect(() =>
			buildFinalArgsByMethod(
				"update",
				"scala_docs_files",
				{ data: { content: "x" } },
				undefined,
				config,
				context,
			),
		).toThrow(/needs a row address.*where/s);
	});

	test("clean shape still works: id top-level + data", () => {
		const result = buildFinalArgsByMethod(
			"update",
			"scala_docs_files",
			{ id: "abc", data: { content: "x" } },
			undefined,
			config,
			context,
		);
		expect((result.where as Record<string, unknown>).id).toBe("abc");
		expect((result.data as Record<string, unknown>).content).toBe("x");
	});
});

describe("composite Prisma identity invocation", () => {
	const config: OrpcExecutorConfig = {
		executor_key: "orpc",
		scopeType: "public",
		autoTransformUpdate: true,
		identifierFields: ["slug", "dep_type"],
		flatFilterFields: ["slug", "dep_type"],
	};

	test("get uses both key fields and never invents id", () => {
		expect(buildFinalArgsByMethod("findUnique", "codegen_output_type_deps", {
			slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client",
		}, ["slug", "dep_type"], config, context)).toEqual({
			where: { slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client" },
			select: { slug: true, dep_type: true },
		});
	});

	test("list selects real composite keys only", () => {
		expect(buildFinalArgsByMethod("findMany", "codegen_output_type_deps", {
			fields: ["slug", "dep_type", "output_type"], take: 10,
		}, undefined, config, context)).toEqual({
			where: {}, take: 10,
			select: { slug: true, dep_type: true, output_type: true },
		});
	});

	test("update transforms both key fields into one where", () => {
		expect(buildFinalArgsByMethod("update", "codegen_output_type_deps", {
			slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client", enabled: true,
		}, ["slug", "dep_type"], config, context)).toEqual({
			where: { slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client" },
			data: { enabled: true },
			select: { slug: true, dep_type: true },
		});
	});

	test("delete builds the composite where", () => {
		expect(buildFinalArgsByMethod("delete", "codegen_output_type_deps", {
			slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client",
		}, undefined, config, context)).toEqual({
			where: { slug: "scala-mcp-orpc-bundle", dep_type: "prisma-client" },
		});
	});

	test("partial composite identity is rejected", () => {
		expect(() => buildFinalArgsByMethod("update", "codegen_output_type_deps", {
			slug: "scala-mcp-orpc-bundle", enabled: true,
		}, ["slug", "dep_type"], config, context)).toThrow(
			"requires all composite identity fields: slug, dep_type",
		);
	});
});

describe("a discarded argument is refused, never silently dropped", () => {
	// `select` is the Prisma name for a column projection; this surface calls it
	// `fields`. Valibot strips the unknown key at the ORPC edge, so before this
	// guard the call succeeded and returned the DEFAULT projection — the caller's
	// requested columns were the only ones missing, with nothing to indicate the
	// argument had been thrown away.
	//
	// This test exists because that silence cost a real misdiagnosis: an
	// orchestrator asked for `role`/`message_type`, got id/created_at/updated_at,
	// concluded the gateway was broken, screen-scraped tmux instead, and
	// interrupted five lanes that were working (2026-08-08).
	const config = { model: "work_items" } as unknown as OrpcExecutorConfig;

	test("`select` throws and the message names `fields`", async () => {
		const call = prepareArgs({ select: ["title"] }, "findMany", "work_items", context, config);
		await expect(call).rejects.toThrow(/`fields`/);
	});

	test("the message says WHY, so the caller does not read it as caller error", async () => {
		const call = prepareArgs({ select: ["title"] }, "findMany", "work_items", context, config);
		// "discarded before it reaches the database" is the load-bearing clause:
		// without it the error reads as "unsupported option" rather than "your
		// columns were dropped", which is the fact that changes what you do next.
		await expect(call).rejects.toThrow(/discarded/);
	});

	test("`fields` itself is untouched — the guard refuses one key, not projection", async () => {
		const args: Record<string, unknown> = { fields: ["title"], take: 5 };
		await prepareArgs(args, "findMany", "work_items", context, config);
		expect(args.fields).toEqual(["title"]);
	});
});

describe("generated protected-subtype boundary", () => {
	const protectedConfig = {
		executor_key: "orpc",
		scopeType: "public",
		idField: "id",
		flatFilterFields: ["id", "type", "slug"],
		whereConstraint: { type: { notIn: ["secret"] } },
		forbiddenFieldValues: { type: ["secret"] },
	} as OrpcExecutorConfig;

	test("every read is constrained away from protected rows", () => {
		expect(buildFinalArgsByMethod(
			"findMany",
			"registry_entries",
			{ take: 20 },
			["id", "type", "slug"],
			protectedConfig,
			context,
		)).toEqual({
			where: { type: { notIn: ["secret"] } },
			take: 20,
			select: { id: true, type: true, slug: true },
		});
	});

	test("identity reads retain the protection as an AND constraint", () => {
		expect(buildFinalArgsByMethod(
			"findFirst",
			"registry_entries",
			{ id: "row-1" },
			["id", "type"],
			protectedConfig,
			context,
		)).toEqual({
			where: {
				AND: [{ id: "row-1" }, { type: { notIn: ["secret"] } }],
			},
			select: { id: true, type: true },
		});
	});

	test("a protected subtype write is refused before dispatch", async () => {
		await expect(prepareArgs(
			{ type: "secret", slug: "credential", config: {} },
			"create",
			"registry_entries",
			context,
			protectedConfig,
		)).rejects.toThrow(/owning local capability/);
	});

	test("a protected unique update keeps a Prisma-valid unique where", () => {
		expect(buildFinalArgsByMethod(
			"update",
			"registry_entries",
			{ id: "row-1", config: { enabled: true } },
			undefined,
			protectedConfig,
			context,
		)).toEqual({
			where: { id: "row-1" },
			data: { config: { enabled: true } },
			select: { id: true },
		});
	});
});

describe("bulk mutations carry separated where/data namespaces (2026-08-16 incident)", () => {
	// The measured failure: `work_items update_many` called with flat
	// kind/title/organisation_id, read by the caller as a FILTER and consumed
	// as SET-VALUES, rewrote 6,890 titles org-wide while reporting success.
	// The dispatch layer must make that call unrepresentable.
	const bulkConfig: OrpcExecutorConfig = {
		executor_key: "orpc",
		scopeType: "org",
		idField: "id",
		identifierFields: ["id"],
		flatFilterFields: ["id", "organisation_id", "status"],
		autoTransformUpdate: true,
	};

	test("the exact incident call is refused naming where and data", () => {
		expect(() =>
			buildFinalArgsByMethod(
				"updateMany",
				"work_items",
				{
					kind: "subtask",
					title: "capture-test-470-project",
					organisation_id: "org-1",
				},
				undefined,
				bulkConfig,
				context,
			),
		).toThrow(/update_many.*`where`.*`data`/s);
	});

	test("a properly-filtered bulk update builds where+data and nothing else", () => {
		const result = buildFinalArgsByMethod(
			"updateMany",
			"work_items",
			{
				where: { status: "pending", organisation_id: "org-1" },
				data: { title: "New title" },
			},
			undefined,
			bulkConfig,
			context,
		);
		expect(result).toEqual({
			where: { status: "pending", organisation_id: "org-1" },
			data: { title: "New title" },
		});
	});

	test("delete_many without where is refused; with where it builds the delete", () => {
		expect(() =>
			buildFinalArgsByMethod(
				"deleteMany",
				"work_items",
				{ kind: "subtask" },
				undefined,
				bulkConfig,
				context,
			),
		).toThrow(/delete_many/);
		expect(() =>
			buildFinalArgsByMethod(
				"deleteMany",
				"work_items",
				{},
				undefined,
				bulkConfig,
				context,
			),
		).toThrow(/requires `where`/);
		expect(
			buildFinalArgsByMethod(
				"deleteMany",
				"work_items",
				{ where: { status: "archived" } },
				undefined,
				bulkConfig,
				context,
			),
		).toEqual({ where: { status: "archived" } });
	});

	test("delete_many keeps the single-id convenience as where, never a stray", () => {
		expect(
			buildFinalArgsByMethod(
				"deleteMany",
				"work_items",
				{ id: "row-1" },
				undefined,
				bulkConfig,
				context,
			),
		).toEqual({ where: { id: "row-1" } });
	});

	test("update (single row) keeps its flat form — the gate scopes to bulk only", () => {
		expect(
			buildFinalArgsByMethod(
				"update",
				"work_items",
				{ id: "row-1", title: "New title" },
				undefined,
				bulkConfig,
				context,
			),
		).toEqual({
			where: { id: "row-1" },
			data: { title: "New title" },
			select: { id: true },
		});
	});
});
