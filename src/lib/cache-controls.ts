/**
 * @system tool-executor
 * @status handwritten
 */

import { loadRegistryConfig } from "@teamscala/db/registry/load-config";
import * as v from "valibot";

const ToolExecutorCacheControlsSchema = v.object({
	ftsRefreshIntervalMs: v.number(),
	adapterDefinitionsTtlMs: v.number(),
});

export async function loadToolExecutorCacheControls(): Promise<
	v.InferOutput<typeof ToolExecutorCacheControlsSchema>
> {
	return loadRegistryConfig(
		"config",
		"tool-executor-cache-controls",
		ToolExecutorCacheControlsSchema,
	);
}
