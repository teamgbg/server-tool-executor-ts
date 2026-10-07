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
import type { ExecutionContext, OrpcExecutorConfig } from "../lib/types.ts";
import { buildUpdateArgs } from "./orpc-args.ts";

configure({
	getPrisma: () => ({
		_runtimeDataModel: {
			models: {
				host_commands: {
					fields: [
						{ name: "id", type: "String", kind: "scalar" },
						{ name: "priority", type: "Int", kind: "scalar" },
						{ name: "telegram_chat_id", type: "String", kind: "scalar" },
					],
				},
			},
		},
	}),
});

const config: OrpcExecutorConfig = {
	executor_key: "orpc",
	scopeType: "public",
	autoTransformUpdate: true,
	identifierField: "id",
};
const ctx = {} as ExecutionContext;

describe("buildUpdateArgs — schema-derived numeric coercion", () => {
	test("preserves an Int column as a number", () => {
		const data = buildUpdateArgs(
			{ id: "abc", priority: 1 },
			config,
			ctx,
			"host_commands",
		).data as Record<string, unknown>;
		expect(data.priority).toBe(1);
	});

	test("still stringifies a numeric value sent for a String column", () => {
		const data = buildUpdateArgs(
			{ id: "abc", telegram_chat_id: 8515867758 },
			config,
			ctx,
			"host_commands",
		).data as Record<string, unknown>;
		expect(data.telegram_chat_id).toBe("8515867758");
	});
});
