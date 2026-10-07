/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import { executeHostCommand } from "@teamscala/tool-executor-host-bus/executors/host-command.ts";
import { executeSdkTool } from "@teamscala/tool-executor-adapters/executors/sdk.ts";
import { executeUiActionTool } from "../executors/ui-action";
import { executeOrpcProcedure } from "@teamscala/tool-executor-orpc/executors/orpc.ts";
import { validateToolInput } from "@teamscala/formatters/validate-json-schema";
import type {
	ExecutionContext,
	OrpcExecutorConfig,
	ToolDefinition,
} from "@teamscala/tool-executor-substrate/lib/types.ts";

const logger = getLogger();

interface ExecutorHandler {
	matches: (executorKey: string) => boolean;
	execute: (
		tool: ToolDefinition,
		args: Record<string, unknown>,
		context: ExecutionContext,
	) => Promise<unknown>;
}

/**
 * Registered executor dispatch table. Adding a backend is ONE entry here, never
 * an edit to an if/else chain — the table-driven shape replaces the prior
 * hardcoded discriminator. The ORPC handler is the catch-all default and must
 * remain LAST.
 */
export const EXECUTORS: ExecutorHandler[] = [
	// Host-command executor — row-bus dispatch. Writes a host_commands intent
	// row and awaits the dev-host consumer's result row, replacing the blocking
	// ORPC path for tools that act on a local process the cloud cannot reach
	// (spawn_agent_tab, close_agent_tab, ...). See action-emission-architecture.md.
	{ matches: (k) => k === "host_command", execute: executeHostCommand },
	// SDK executor — IN-PROCESS. The service hosting an sdk:* tool loads the
	// installed @teamscala/api-* adapter via createRequire and calls the
	// operation directly (operator ruling 2026-09-02: no HTTP self-loopback
	// through the service's own /mcp, and no bearer-token plumbing — the
	// adapter's credentials resolve from config/adapter rows + env, never
	// from an authenticated call to itself).
	{ matches: (k) => k.startsWith("sdk:"), execute: executeSdkTool },
	// UI-action executor — a row-declared UI surface (show_form, show_document,
	// focus_work_item, ...). The action, the procedure and the payload template
	// are executor_config: adding a surface is a row, not a branch here. Scope
	// "agent" re-derives the caller's allowed ids from the agent row, because
	// ExecutionContext is identity-only and cannot carry build-time lists. See
	// executors/ui-action.ts.
	{ matches: (k) => k === "ui-action", execute: executeUiActionTool },
	// Default — ORPC procedure dispatch (every active mcp_tool/ai_tools row).
	{ matches: () => true, execute: executeOrpcDefault },
];

async function executeOrpcDefault(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
): Promise<unknown> {
	const config = tool.executor_config as OrpcExecutorConfig;
	logger.info(`[Executor] Executing tool: ${tool.name}`, {
		executor_key: tool.executor_key ?? "",
		hasOrpcProcedure: !!tool.orpc_procedure,
		hasActionMap: !!config.actionMap,
		hasProcedureMap: !!config.procedureMap,
	});
	return dispatchOrpc(tool, args, context, config);
}

export async function executeTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
): Promise<unknown> {
	if (!tool.executor_config) {
		throw new Error(
			`Tool ${tool.name} is missing executor_config. ` +
				`Every tool must have an executor_config — add one via the mcp_tool registry row.`,
		);
	}

	// THE SCHEMA IS THE CONTRACT, ENFORCED AT DISPATCH. A schema declaring
	// additionalProperties:false must actually refuse undeclared keys — without
	// this check the flag is advertised to the model and ignored by the
	// executor, so an unknown key (`filters: {status}` on work_items) was
	// silently DROPPED and the caller got unrelated rows that read as an answer
	// to a question nobody asked (measured 2026-08-16). Validated BEFORE the
	// default_args merge: row-owned routing args are trusted data, not caller
	// input, and must not be refused by a schema the caller never sees.
	if (tool.input_schema) {
		const validationError = validateToolInput(
			args,
			tool.input_schema as Record<string, unknown>,
		);
		if (validationError) {
			throw new Error(
				`Tool ${tool.name} refused the arguments: ${validationError}. ` +
					`Unknown keys are rejected, not ignored — use only the properties declared in this tool's input schema.`,
			);
		}
	}

	// DB-driven arg injection: executor_config.default_args are merged UNDER the
	// caller's args (caller wins), so a row can bake in routing args the caller
	// never sees. A tool like `search` routes to a specific engine op
	// (op:"pattern_search") via the row, while the caller passes only
	// {pattern, scope} — the routing is data, not code, and swapping the engine
	// is a row edit. Without this, a caller would have to pass the internal op,
	// leaking the routing detail the row is meant to own.
	const defaultArgs = (
		tool.executor_config as { default_args?: Record<string, unknown> }
	).default_args;
	const mergedArgs = defaultArgs ? { ...defaultArgs, ...args } : args;

	const executorKey = tool.executor_key ?? "";
	for (const handler of EXECUTORS) {
		if (handler.matches(executorKey)) return handler.execute(tool, mergedArgs, context);
	}
	// Unreachable: the ORPC handler matches every key. Guard for safety.
	throw new Error(`No executor registered for key "${executorKey}"`);
}

async function dispatchOrpc(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
	config: OrpcExecutorConfig,
): Promise<unknown> {
	if (!config.scopeType) {
		const schemaProps = ((
			tool.input_schema as Record<string, unknown> | undefined
		)?.properties ?? {}) as Record<string, unknown>;
		config.scopeType = schemaProps.organisation_id
			? "org"
			: schemaProps.user_id
				? "user"
				: "public";
		logger.warn(
			`[Executor] Tool ${tool.name} executor_config.scopeType missing — inferred "${config.scopeType}" from input_schema. ` +
				`Regenerate the ai_tools row via the tool-generator to remove this fallback.`,
		);
	}
	const hasActionRouting =
		args.action !== undefined && (config.actionMap || config.procedureMap);
	let procedure = hasActionRouting
		? resolveProcedureFromAction(args, config)
		: tool.orpc_procedure;

	if (
		!config.procedureMap &&
		!config.actionMap &&
		args.action !== undefined &&
		args.model !== undefined
	) {
		const model = String(args.model);
		const action = String(args.action);
		if (
			[
				"create",
				"update",
				"delete",
				"delete_many",
				"update_many",
				"count",
			].includes(action)
		) {
			procedure = `${model}.${action}`;
		}
	}
	if (!procedure) {
		throw new Error(
			`Tool ${tool.name} has no orpc_procedure and no actionMap/procedureMap to resolve action`,
		);
	}
	return executeOrpcProcedure(procedure, args, context, config);
}

function resolveProcedureFromAction(
	args: Record<string, unknown>,
	config: OrpcExecutorConfig,
): string {
	const actionMap = config.actionMap || config.procedureMap;
	if (!actionMap) {
		throw new Error(
			"ORPC tool has no actionMap or procedureMap in executor_config",
		);
	}

	const rawAction = args.action ? String(args.action) : "list";
	const action = rawAction.includes(".") ? rawAction.split(".")[1]! : rawAction;
	const mapped = actionMap[action];

	if (!mapped) {
		const validActions = Object.keys(actionMap).join(", ");
		throw new Error(
			`Unknown action "${action}". Valid actions: ${validActions}`,
		);
	}

	let procedure =
		typeof mapped === "string"
			? mapped
			: (mapped as { procedure: string }).procedure;

	if (!procedure.includes(".")) {
		const model =
			args.model !== undefined
				? String(args.model)
				: (config as { model?: string }).model;
		if (!model) {
			throw new Error(
				`procedureMap value "${procedure}" has no model prefix and config.model is unset — cannot resolve to model.method`,
			);
		}
		procedure = `${model}.${procedure}`;
	} else if (args.model !== undefined) {
		const requestedModel = String(args.model);
		const dotIdx = procedure.indexOf(".");
		const defaultModel = procedure.substring(0, dotIdx);
		if (defaultModel !== requestedModel) {
			procedure = `${requestedModel}${procedure.substring(dotIdx)}`;
		}
	}

	return procedure;
}
