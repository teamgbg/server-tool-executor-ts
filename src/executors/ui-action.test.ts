// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.
import { afterAll as __scalaRestoreGlobals } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const __scalaDomWasMissing = !globalThis.document;
if (__scalaDomWasMissing) GlobalRegistrator.register();
__scalaRestoreGlobals(async () => {
    if (__scalaDomWasMissing) await GlobalRegistrator.unregister();
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// The executor reads rows through the ORPC procedures it is given; this suite
// stands in for the router so the assertions are about the FAMILY's contract —
// agent-scoped authorization, the id match, and the declared payload — not about
// a service's generated routers.
const calls: Array<{ procedure: string; args: Record<string, unknown> }> = [];
let agentRow: Record<string, unknown> | null = null;
let entityResult: unknown = null;

mock.module("@teamscala/tool-executor-orpc/executors/orpc.ts", () => ({
	executeOrpcProcedure: async (procedure: string, args: Record<string, unknown>) => {
		calls.push({ procedure, args });
		if (procedure === "ai_agents.findFirst") return agentRow;
		return entityResult;
	},
}));

const { executeUiActionTool } = await import("./ui-action");
const { renderUiActionDescription } = await import("./ui-action-description");

type Toolish = Parameters<typeof executeUiActionTool>[0];
type Ctx = Parameters<typeof executeUiActionTool>[2];

const tool = (executorConfig: unknown): Toolish =>
	({
		id: "tool-1",
		name: "show_form",
		executor_key: "ui-action",
		service: null,
		endpoint: null,
		http_method: null,
		orpc_procedure: null,
		executor_config: executorConfig as Record<string, unknown>,
	}) as unknown as Toolish;

const context = (over: Partial<Ctx> = {}): Ctx =>
	({
		userId: "user-1",
		organisationId: "org-1",
		agentId: "agent-1",
		...over,
	}) as Ctx;

const formRow = {
	id: "form-uuid-1",
	form_id: "public-form-1",
	name: "Intake",
	organisation_id: "org-1",
};

const config = {
	action: "show_form",
	resolve: {
		procedure: "forms.findMany",
		idArg: "form_id",
		idField: "id",
		scope: "agent" as const,
		agentIdsField: "form_ids",
	},
	payload: {
		success: true,
		action: "show_form",
		url: "/form/{organisationId}/{resolve.form_id}",
		title: "{resolve.name}",
	},
};

beforeEach(() => {
	calls.length = 0;
	agentRow = { id: "agent-1", form_ids: ["form-uuid-1"] };
	entityResult = [formRow];
});

describe("ui-action > agent scope is re-derived from the agent row, never handed in", () => {
	test("a held id renders the declared payload from the resolved row and the context", async () => {
		const result = await executeUiActionTool(tool(config), { form_id: "form-uuid-1" }, context());

		expect(result).toEqual({
			success: true,
			action: "show_form",
			url: "/form/org-1/public-form-1",
			title: "Intake",
		});
		expect(calls[0]?.procedure).toBe("ai_agents.findFirst");
		expect(calls[0]?.args).toEqual({ id: "agent-1" });
		expect(calls[1]?.procedure).toBe("forms.findMany");
		expect(calls[1]?.args).toEqual({ id: "form-uuid-1" });
	});

	test("an id the agent does not hold is not found, and the entity row is never read", async () => {
		const result = await executeUiActionTool(tool(config), { form_id: "someone-elses-form" }, context());

		expect(result).toEqual({ success: false, error: "show_form: not found" });
		expect(calls.map((c) => c.procedure)).toEqual(["ai_agents.findFirst"]);
	});

	test("an agent row with no ids array proves nothing, so the answer is not found", async () => {
		agentRow = { id: "agent-1" };

		const result = await executeUiActionTool(tool(config), { form_id: "form-uuid-1" }, context());

		expect(result).toEqual({ success: false, error: "show_form: not found" });
		expect(calls.map((c) => c.procedure)).toEqual(["ai_agents.findFirst"]);
	});

	test("no agentId in the context is not an unrestricted caller", async () => {
		const result = await executeUiActionTool(
			tool(config),
			{ form_id: "form-uuid-1" },
			context({ agentId: undefined }),
		);

		expect(result).toEqual({ success: false, error: "show_form: not found" });
		expect(calls).toHaveLength(0);
	});

	test("scope agent without agentIdsField refuses by name — an unprovable scope is not a permissive one", async () => {
		const unprovable = {
			...config,
			resolve: { ...config.resolve, agentIdsField: undefined },
		};

		await expect(
			executeUiActionTool(tool(unprovable), { form_id: "form-uuid-1" }, context()),
		).rejects.toThrow(/agentIdsField/);
	});
});

describe("ui-action > the row declares the action, never the code", () => {
	test("two rows differing only in data render their own actions from one family", async () => {
		entityResult = { ...formRow, id: "doc-uuid-1", name: "Deck" };
		const document = {
			...config,
			action: "show_document",
			resolve: { ...config.resolve, procedure: "documents.findMany", agentIdsField: "document_ids" },
			payload: { success: true, action: "show_document", url: "/doc/{organisationId}/{resolve.id}" },
		};
		agentRow = { id: "agent-1", document_ids: ["doc-uuid-1"] };

		const result = await executeUiActionTool(tool(document), { form_id: "doc-uuid-1" }, context());

		expect(result).toEqual({ success: true, action: "show_document", url: "/doc/org-1/doc-uuid-1" });
	});

	test("org scope reads no agent row at all", async () => {
		const orgScoped = {
			...config,
			resolve: { procedure: "forms.findMany", idArg: "form_id", idField: "id", scope: "org" as const },
		};

		const result = await executeUiActionTool(tool(orgScoped), { form_id: "form-uuid-1" }, context());

		expect(result).toEqual({
			success: true,
			action: "show_form",
			url: "/form/org-1/public-form-1",
			title: "Intake",
		});
		expect(calls.map((c) => c.procedure)).toEqual(["forms.findMany"]);
	});

	test("org scope with no organisation in the context is not found, not a cross-org render", async () => {
		const orgScoped = {
			...config,
			resolve: { procedure: "forms.findMany", idArg: "form_id", idField: "id", scope: "org" as const },
		};

		const result = await executeUiActionTool(
			tool(orgScoped),
			{ form_id: "form-uuid-1" },
			context({ organisationId: undefined }),
		);

		expect(result).toEqual({ success: false, error: "show_form: not found" });
	});
});

describe("ui-action > an incomplete row fails at the row, not halfway through a render", () => {
	test("a row with no action names the field", async () => {
		await expect(
			executeUiActionTool(tool({ ...config, action: "" }), { form_id: "form-uuid-1" }, context()),
		).rejects.toThrow(/"action"/);
	});

	test("a row with a resolve block naming none of its fields names them", async () => {
		await expect(
			executeUiActionTool(tool({ action: "show_form", resolve: {} }), { form_id: "form-uuid-1" }, context()),
		).rejects.toThrow(/procedure, idArg and idField/);
	});

	test("a ui-action key with no executor_config at all refuses before any read", async () => {
		await expect(
			executeUiActionTool(tool(null), { form_id: "form-uuid-1" }, context()),
		).rejects.toThrow(/no executor_config/);
		expect(calls).toHaveLength(0);
	});

	test("a call without the id arg names the arg the schema should have required", async () => {
		await expect(executeUiActionTool(tool(config), {}, context())).rejects.toThrow(/"form_id"/);
	});

	test("a resolved list holding a different row is not found — the id is matched, not the first hit", async () => {
		entityResult = [{ ...formRow, id: "form-uuid-2" }];

		const result = await executeUiActionTool(tool(config), { form_id: "form-uuid-1" }, context());

		expect(result).toEqual({ success: false, error: "show_form: not found" });
	});
});

describe("ui-action > the description projection renders the ids the agent holds", () => {
	// renderUiActionDescription is a SERVE-TIME helper, not a call-time one: the
	// loader assembling a turn's tool list calls it with the rows it already
	// resolved for this agent. These assert the formatting contract the loader
	// and the row both code against, so the two cannot disagree about shape.

	test("no describe block serves the description verbatim", () => {
		expect(renderUiActionDescription("Show a form.", undefined, [formRow])).toBe("Show a form.");
	});

	test("rows the agent holds render under the declared heading and label field", () => {
		const out = renderUiActionDescription(
			"Show a form.",
			{ heading: "Available forms:", labelField: "name" },
			[formRow, { id: "form-uuid-2", name: "Outreach" }],
		);

		expect(out).toBe(
			'Show a form. Available forms:\n- "Intake" (id: form-uuid-1)\n- "Outreach" (id: form-uuid-2)',
		);
	});

	test("an empty held-rows list adds nothing — no empty list shown for a form-less agent", () => {
		expect(
			renderUiActionDescription("Show a form.", { heading: "Available forms:", labelField: "name" }, []),
		).toBe("Show a form.");
	});

	test("the label field is the row's, so assessments render title where forms render name", () => {
		const out = renderUiActionDescription(
			"Show an assessment.",
			{ heading: "Available assessments:", labelField: "title" },
			[{ id: "a-1", title: "Discovery" }],
		);

		expect(out).toBe('Show an assessment. Available assessments:\n- "Discovery" (id: a-1)');
	});
});

describe("ui-action > an echo row renders the caller's own id and reads nothing", () => {
	// show_document / show_website: the AI supplies an id and the CLIENT resolves
	// it against its own page state. There is no server entity, so resolve is
	// absent and no scope check applies — nothing server-side can leak. The row
	// still declares the action and the payload; the id returns through {arg.*}.

	const echo = {
		action: "show_document",
		payload: {
			success: true,
			action: "show_document",
			documentId: "{arg.document_id}",
			url: "/document/{arg.document_id}",
		},
	};

	test("an echo row renders the caller's id and makes zero reads", async () => {
		const result = await executeUiActionTool(
			tool(echo),
			{ document_id: "doc-uuid-1" },
			context(),
		);

		expect(result).toEqual({
			success: true,
			action: "show_document",
			documentId: "doc-uuid-1",
			url: "/document/doc-uuid-1",
		});
		expect(calls).toHaveLength(0);
	});

	test("an echo placeholder with no matching arg renders empty, never the literal token", async () => {
		const result = await executeUiActionTool(
			tool(echo),
			{ unrelated: "x" },
			context(),
		);

		expect(result).toEqual({
			success: true,
			action: "show_document",
			documentId: "",
			url: "/document/",
		});
	});

	test("an echo row with no payload refuses by name — an echo that declares nothing is not an action", async () => {
		await expect(
			executeUiActionTool(tool({ action: "show_document" }), { document_id: "doc-uuid-1" }, context()),
		).rejects.toThrow(/payload/);
		expect(calls).toHaveLength(0);
	});

	test("an echo row with no action still refuses — the verb is the row's declaration", async () => {
		await expect(
			executeUiActionTool(tool({ ...echo, action: "" }), { document_id: "doc-uuid-1" }, context()),
		).rejects.toThrow(/"action"/);
	});

	test("two echo rows differ only in data — one family, two surfaces, no code between them", async () => {
		const website = {
			...echo,
			action: "show_website",
			payload: { success: true, action: "show_website", pageId: "{arg.page_id}" },
		};

		const result = await executeUiActionTool(tool(website), { page_id: "page-uuid-1" }, context());

		expect(result).toEqual({ success: true, action: "show_website", pageId: "page-uuid-1" });
		expect(calls).toHaveLength(0);
	});
});
