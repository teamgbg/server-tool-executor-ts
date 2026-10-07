// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { executeHostCommand } from "../executors/host-command";
import { executeSdkTool } from "../executors/sdk";
import { executeTool, EXECUTORS } from "./dispatch";

function handlerFor(key: string) {
	return EXECUTORS.find((e) => e.matches(key)) ?? null;
}

describe("executor dispatch table (registered, not if/else)", () => {
	test("host_command routes to the host-command handler", () => {
		expect(handlerFor("host_command")?.execute).toBe(executeHostCommand);
	});

	test("sdk:<name> routes to the IN-PROCESS SDK executor across the prefix family", () => {
		// Operator ruling 2026-09-02: an sdk tool inside the adapter-hosting
		// service executes the installed adapter directly — never an HTTP
		// self-loopback through its own /mcp.
		expect(handlerFor("sdk:api_fathom")?.execute).toBe(executeSdkTool);
		expect(handlerFor("sdk:api_ghl")?.execute).toBe(executeSdkTool);
	});

	test("the ORPC default is the catch-all for every other key", () => {
		const def = handlerFor("orpc");
		expect(def).not.toBeNull();
		expect(handlerFor("")).toBe(def);
		expect(handlerFor("anything-unknown")).toBe(def);
	});

	test("the default handler is LAST and matches every key", () => {
		const last = EXECUTORS[EXECUTORS.length - 1]!;
		expect(last.matches("host_command")).toBe(true);
		expect(last.matches("sdk:x")).toBe(true);
		expect(last.matches("orpc")).toBe(true);
	});
});

describe("dispatch enforces the input schema it serves", () => {
	const schema = {
		type: "object",
		properties: {
			action: { type: "string" },
			status: { type: "string" },
		},
		required: ["action"],
		additionalProperties: false,
	};

	async function callWith(args: Record<string, unknown>) {
		return executeTool(
			{
				id: "t1",
				name: "widget",
				description: null,
				executor_key: "orpc",
				service: null,
				endpoint: null,
				http_method: null,
				orpc_procedure: null,
				executor_config: {
					scopeType: "public",
					procedureMap: { list: "widget.findMany" },
				},
				input_schema: schema,
			},
			args,
			{} as never,
		);
	}

	test("an undeclared key is REFUSED, never silently dropped", async () => {
		// The defect (measured 2026-08-16): work_items list with
		// filters:{status:'in-progress'} dropped the wrapper and returned
		// unrelated rows that read as an answer to the wrong question.
		let message = "";
		try {
			await callWith({ action: "list", filters: { status: "in-progress" } });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("refused the arguments");
		expect(message).toContain("filters");
	});

	test("declared keys are not refused — the gate only rejects the undeclared", async () => {
		// Reaches the executor (which needs a router) — the contract check has
		// passed when the failure is the executor's own, not the refusal.
		let message = "";
		try {
			await callWith({ action: "list", status: "todo" });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).not.toContain("refused the arguments");
	});
});
