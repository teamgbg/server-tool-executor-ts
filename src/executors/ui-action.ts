/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import type {
	ExecutionContext,
	OrpcExecutorConfig,
	ToolDefinition,
	UiActionExecutorConfig,
} from "@teamscala/tool-executor-substrate/lib/types.ts";
import { executeOrpcProcedure } from "./orpc.ts";

const logger = getLogger();

/** The agent lookup used when a row declares scope "agent" without naming one. */
const DEFAULT_AGENT_PROCEDURE = "ai_agents.findFirst";

/**
 * Interpolate `{resolve.<field>}` / `{arg.<name>}` / `{organisationId}` /
 * `{userId}` / `{agentId}` into a declared payload. A placeholder with no value
 * renders as the empty string rather than leaking the literal token to a
 * client, and a non-string payload value passes through unchanged. `{arg.*}`
 * exists for echo rows (no resolve): the caller already holds the id, so the
 * payload echoes what the client will resolve on its own page state.
 */
function interpolate(
	value: unknown,
	resolved: Record<string, unknown>,
	args: Record<string, unknown>,
	context: ExecutionContext,
): unknown {
	if (typeof value === "string") {
		let out = value;
		for (const [field, cell] of Object.entries(resolved)) {
			out = out.replaceAll(`{resolve.${field}}`, cell == null ? "" : String(cell));
		}
		for (const [name, cell] of Object.entries(args)) {
			if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") {
				out = out.replaceAll(`{arg.${name}}`, String(cell));
			}
		}
		// A placeholder naming a field the row/args do not hold renders empty,
		// never the literal token: after substitution anything still shaped
		// {resolve.*} / {arg.*} had no source, so it is dropped. (Measured by the
		// suite: a leaked "{arg.document_id}" in a served payload IS the failure
		// this replaces.)
		out = out.replace(/\{(?:resolve|arg)\.[^{}]+\}/g, "");
		out = out
			.replaceAll("{organisationId}", context.organisationId ?? "")
			.replaceAll("{userId}", context.userId ?? "")
			.replaceAll("{agentId}", context.agentId ?? "");
		return out;
	}
	if (Array.isArray(value)) return value.map((entry) => interpolate(entry, resolved, args, context));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(entry, resolved, args, context);
		}
		return out;
	}
	return value;
}

/**
 * The ids the calling agent is allowed to reach, read from its own row.
 * A null return means MEMBERSHIP COULD NOT BE ESTABLISHED, and the caller
 * treats that exactly like an id the agent does not hold.
 */
async function agentAllowedIds(
	tool: ToolDefinition,
	config: UiActionExecutorConfig,
	context: ExecutionContext,
): Promise<string[] | null> {
	if (!context.agentId) return null;
	const procedure = config.resolve.agentProcedure ?? DEFAULT_AGENT_PROCEDURE;
	const idsField = config.resolve.agentIdsField;
	if (!idsField) {
		throw new Error(
			`Tool ${tool.name}: ui-action resolve with scope "agent" must declare agentIdsField — the agent row's field holding the allowed ids. Without it membership cannot be proven, and an unprovable scope is not a permissive one.`,
		);
	}
	const agentRow = (await executeOrpcProcedure(
		procedure,
		{ id: context.agentId },
		context,
		config as unknown as OrpcExecutorConfig,
	)) as Record<string, unknown> | null;
	const raw = agentRow?.[idsField];
	if (!Array.isArray(raw)) return null;
	return raw.map((entry) => String(entry));
}

export async function executeUiActionTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
): Promise<unknown> {
	const config = tool.executor_config as UiActionExecutorConfig | null | undefined;

	if (!config || typeof config !== "object") {
		throw new Error(
			`Tool ${tool.name} declares executor_key "ui-action" but carries no executor_config — the action, the resolve and the payload are the row's declaration, never a code default.`,
		);
	}
	if (!config.action) {
		throw new Error(
			`Tool ${tool.name}: ui-action executor_config must declare "action" — the UI verb the client renders.`,
		);
	}

	// ECHO ROWS. resolve is OPTIONAL: a surface with no server entity (the AI
	// supplies a document_id / page_id and the CLIENT resolves it against its
	// own page state) has nothing for resolve to find and no scope check that
	// applies — there is no row to leak. The row still declares the action and
	// the payload; the id comes back through {arg.<name>}. What resolve grants
	// when PRESENT is unchanged below: read the row through the declared
	// procedure and authorize it against the agent before rendering.
	if (!config.resolve) {
		if (!config.payload) {
			throw new Error(
				`Tool ${tool.name}: echo ui-action (no resolve) must declare a payload — an echo with nothing declared is a row that renders nothing.`,
			);
		}
		return interpolate(config.payload, {}, args, context);
	}

	const { procedure, idArg, idField } = config.resolve;
	if (!procedure || !idArg || !idField) {
		throw new Error(
			`Tool ${tool.name}: ui-action resolve must declare procedure, idArg and idField ("model.method", the arg carrying the id, the row field it matches).`,
		);
	}

	const targetId = args[idArg];
	if (typeof targetId !== "string" || targetId.length === 0) {
		throw new Error(`Tool ${tool.name}: missing required arg "${idArg}".`);
	}

	const notFound = { success: false, error: `${config.action}: not found` };

	// AGENT SCOPE, BEFORE the entity read: a caller must not learn whether a
	// row exists by asking for one its agent does not hold.
	let allowedIds: string[] | null = null;
	if (config.resolve.scope === "agent") {
		allowedIds = await agentAllowedIds(tool, config, context);
		if (!allowedIds || !allowedIds.includes(targetId)) {
			logger.info("[ui-action] refused: the calling agent does not hold the target", {
				tool: tool.name,
				agentId: context.agentId ?? null,
				idArg,
			});
			return notFound;
		}
	}

	const result = await executeOrpcProcedure(
		procedure,
		{ [idField]: targetId },
		context,
		config as unknown as OrpcExecutorConfig,
	);
	const rows = (Array.isArray(result) ? result : result ? [result] : []) as Record<
		string,
		unknown
	>[];
	const resolved = rows.find((row) => row?.[idField] === targetId);
	if (!resolved) return notFound;
	if (config.resolve.scope === "org" && !context.organisationId) {
		logger.info("[ui-action] refused: org scope with no organisation in the context", {
			tool: tool.name,
		});
		return notFound;
	}

	return interpolate(config.payload, resolved, args, context);
}
