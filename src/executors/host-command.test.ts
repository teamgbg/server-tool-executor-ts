// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import { busRetiredRefusal, executeHostCommand } from "./host-command.ts";
import type { ToolDefinition } from "../lib/types.ts";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		id: "t1",
		name: "workspace_file",
		executor_key: "host_command",
		service: null,
		endpoint: null,
		http_method: null,
		orpc_procedure: null,
		executor_config: { command: "workspace_file" },
		...overrides,
	};
}

/** Stub for the in-process coding execution — captures the dispatch, touches no fs. */
function makeFakeExec() {
	const calls: Array<{ command: string; merged: Record<string, unknown> }> = [];
	const exec = async (command: string, merged: Record<string, unknown>) => {
		calls.push({ command, merged });
		return { ok: true, result: { stub: true } };
	};
	return { exec: exec as never, calls };
}

describe("executeHostCommand (native path)", () => {
	test("coding commands execute in-process with default_args merged under caller args", async () => {
		const { exec, calls } = makeFakeExec();
		// The `search` tool routes through the `codemod` handler, which
		// requires `op`. The tool_definition carries `default_args: { op: "pattern_search" }`.
		// A schema-valid search call (pattern + scope + maxResults, no `op`)
		// must still reach the handler with `op` merged in.
		const tool = makeTool({
			name: "search",
			executor_config: {
				command: "codemod",
				default_args: { op: "pattern_search" },
			},
		});
		const args = { pattern: "token compression", scope: [], maxResults: 300 };

		const out = (await executeHostCommand(tool, args, {} as never, exec)) as {
			ok: unknown;
		};

		expect(out.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("codemod");
		// The merged payload must contain both the caller's args AND the
		// default `op` — the behavioural fix for the misrouting defect.
		expect(calls[0].merged).toEqual({
			op: "pattern_search",
			pattern: "token compression",
			scope: [],
			maxResults: 300,
		});
	});

	test("caller args override default_args when both specify the same key", async () => {
		const { exec, calls } = makeFakeExec();
		const tool = makeTool({
			executor_config: {
				command: "codemod",
				default_args: { op: "pattern_search", maxResults: 50 },
			},
		});
		// Caller explicitly sets maxResults — must win over the default.
		const args = { pattern: "test", maxResults: 200 };

		await executeHostCommand(tool, args, {} as never, exec);

		expect(calls[0].merged).toEqual({
			op: "pattern_search",
			pattern: "test",
			maxResults: 200,
		});
	});

	test("a non-coding command is REFUSED as data — the bus is retired, never thrown", async () => {
		const { exec, calls } = makeFakeExec();
		const tool = makeTool({
			name: "spawn_agent_tab",
			executor_config: { command: "spawn_agent_tab" },
		});

		// Must NOT throw — a retired capability is an outcome the caller reads,
		// not a dispatch failure.
		const out = (await executeHostCommand(tool, { label: "fleet" }, {} as never, exec)) as {
			ok: unknown;
			error?: unknown;
		};

		expect(out.ok).toBe(false);
		expect(out.error).toContain("host command bus is retired");
		expect(out.error).toContain("scala_tools_exec");
		expect(calls).toHaveLength(0);
	});

	test("throws when executor_config.command is missing", () => {
		const { exec } = makeFakeExec();
		const tool = makeTool({ executor_config: {} });

		expect(executeHostCommand(tool, {}, {} as never, exec)).rejects.toThrow(
			/missing executor_config\.command/,
		);
	});

	test("the retirement refusal names the native verbs", () => {
		const refusal = busRetiredRefusal("spawn_agent_tab");
		expect(refusal.ok).toBe(false);
		expect(refusal.error).toContain("workspace_file");
		expect(refusal.error).toContain("scala-tools verbs");
	});
});
