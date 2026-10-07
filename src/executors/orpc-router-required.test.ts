// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { expect, test } from "bun:test";
import { configure } from "../configure.ts";
import type { OrpcExecutorConfig } from "../lib/types.ts";
import { executeOrpcProcedure } from "./orpc.ts";

test("missing model router refuses instead of dispatching through Prisma", async () => {
	let prismaCalled = false;
	configure({
		getAppRouter: () => ({}),
		getPrisma: () => ({
			comments: {
				create: async () => {
					prismaCalled = true;
				},
			},
		}),
	});

	await expect(
		executeOrpcProcedure(
			"comments.create",
			{ action: "create", content: "x", work_item_id: "task-1" },
			{ userId: "system", organisationId: "org-1" },
			{ scopeType: "public", idField: "id" } as OrpcExecutorConfig,
		),
	).rejects.toThrow(/direct Prisma fallback is prohibited/);
	expect(prismaCalled).toBe(false);
});
