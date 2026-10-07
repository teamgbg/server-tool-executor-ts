/**
 * @system tool-executor
 * @status handwritten
 */

import { createRequire } from "node:module";
import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import type { ExecutionContext, ToolDefinition } from "@teamscala/tool-executor-substrate/lib/types.ts";
import { recordOutboundMessagingSend } from "./messaging-send-recorder.ts";
import { resolveAdapterClientOptions, sdkPackageName } from "./sdk-client-options.ts";

const logger = getLogger();

/**
 * Boot-time gate: verify the adapter package an sdk:* tool declares is
 * requirable in THIS process, through the same entry path the executor
 * uses (entrySubpath — some adapters have no root "." export). The host
 * refuses to boot with an unresolved adapter rather than failing per call
 * (protective-layers-fail-explicitly) — an sdk:* tool hosted by a service
 * whose node_modules lacks the adapter is a deployment-shape defect,
 * surfaced at startup naming the package.
 */
export function assertSdkAdapterResolvable(
	sdkName: string,
	explicitPackageName?: string,
	entrySubpath?: string,
): void {
	const packageName = sdkPackageName(sdkName, explicitPackageName);
	const requirePath = entrySubpath ? `${packageName}/${entrySubpath}` : packageName;
	try {
		createRequire(import.meta.url)(requirePath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`SDK adapter "${requirePath}" is not resolvable in this process — the service hosts ` +
				`sdk:${sdkName} tools without the adapter installed. Install "${packageName}" into ` +
				`this service's node_modules or remove the sdk:${sdkName} rows. Real error: ${reason}`,
		);
	}
}

export async function executeSdkTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
): Promise<unknown> {
	const executorConfig = (tool.executor_config ?? {}) as Record<string, unknown>;
	const sdkName = executorConfig.sdk as string | undefined;
	if (!sdkName) throw new Error(`SDK tool "${tool.name}" has no "sdk" in executor_config`);

	const action = String(args.action ?? "");
	if (!action) throw new Error(`SDK tool "${tool.name}" requires "action" arg`);

	const actionMap = executorConfig.actionMap as Record<string, { method: string; parameters?: string[] }> | undefined;
	const methodDef = actionMap?.[action];
	if (!methodDef) {
		const valid = actionMap ? Object.keys(actionMap).join(", ") : "(none)";
		throw new Error(`Unknown action "${action}". Valid: ${valid}`);
	}

	// Load the adapter package (must be installed in the service's node_modules).
	// entrySubpath: some adapters (e.g. @teamscala/telegram) have no root "." export —
	// the operations live at a subpath (generated/operations.gen). The tool-builder
	// carries entrySubpath in executor_config for these; without it, the require
	// hits the (nonexistent) root export → "not installed".
	const packageName = sdkPackageName(sdkName, executorConfig.packageName as string | undefined);
	const entrySubpath = executorConfig.entrySubpath as string | undefined;
	const requirePath = entrySubpath ? `${packageName}/${entrySubpath}` : packageName;
	let mod: Record<string, unknown>;
	try {
		mod = createRequire(import.meta.url)(requirePath);
	} catch (err) {
		// The swallowed error here misdirected two investigations: the 2026-07-25
		// entrySubpath outage and the 2026-08-26 "api-gowa not installed" report
		// (a missing @teamscala/api-gowa in the calling service's node_modules
		// surfaced as a generic "not installed" rather than MODULE_NOT_FOUND).
		// Surface the real error so the next person investigating this class
		// sees the actual require failure — module-not-found vs. syntax vs.
		// factory-missing all need different fixes.
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`SDK package "${requirePath}" could not be required: ${reason}. ` +
				`If this is MODULE_NOT_FOUND, the package is not installed in this service's node_modules — ` +
				`execute this sdk:* tool from the service that owns the adapter, or remove the duplicate.`,
		);
	}

	// Dispatch mode: "factory" (default — a create*Adapter factory builds a
	// per-call client, e.g. GOWA) or "self-contained" (no factory, no per-call
	// client — the operation resolves its own client internally, e.g.
	// @teamscala/telegram's per-account TDLib ops, configured at boot via
	// configure() + resolveTdlibClient(accountId)).
	const dispatch = (executorConfig.dispatch as string | undefined) ?? "factory";
	// Call the operation
	const fn = mod[methodDef.method] as (...a: unknown[]) => unknown;
	if (typeof fn !== "function") {
		throw new Error(`Function "${methodDef.method}" not found. Available: ${
			Object.keys(mod).filter(k => typeof mod[k] === "function").join(", ")
		}`);
	}

	// Map the operation's DECLARED parameters positionally from args, skipping
	// "client" (always first for factory-dispatch adapters; never a payload —
	// args.client is a credential override). methodDef.parameters lists every
	// declared parameter, so this covers every shape the generator emits —
	// (client), (client, params), (client, body), (client, params, body) — plus
	// self-contained shapes like (token, body). The previous fix resolved ONE
	// payload name (the first non-"client" entry): correct for two-parameter
	// operations, but every three-parameter operation — (client, params, body),
	// 319 of them across the generated adapters — silently lost its body and
	// reached the upstream API without it, an error naming the supplier API
	// rather than this executor, so callers reshaped arguments forever and
	// could never succeed. Map ALL of them; no count special-cases.
	// Legacy rows declare no parameter names: one payload arg from args.params,
	// exactly the pre-declaration behavior.
	const payloadArgs: unknown[] = !methodDef.parameters
		? [(args.params as Record<string, unknown>) ?? {}]
		: methodDef.parameters
				.filter((p) => p !== "client")
				.map((name, i) => {
					if (args[name] !== undefined) return args[name];
					// Legacy callers of single-payload operations sent everything
					// under "params" even where the adapter names the payload
					// differently (GOWA: "body", telegram: "options"); keep that
					// fallback for the FIRST payload parameter only — a
					// multi-payload operation's later parameters have no legacy
					// shape to preserve.
					return i === 0 ? ((args.params as Record<string, unknown>) ?? {}) : undefined;
				});
	logger.info(`[SDK] ${sdkName}.${methodDef.method}`);
	try {
		let result: unknown;
		if (dispatch === "self-contained") {
			result = await fn(...payloadArgs);
		} else {
			// Factory mode: build the per-call client from the adapter's initConfig
			// (field → env-var) resolved from config/sdk-adapter-definitions at call
			// time — secrets stay out of the model, a caller-supplied args.client wins.
			const factoryName = Object.keys(mod).find(k => k.startsWith("create") && k.endsWith("Adapter"));
			if (!factoryName) {
				throw new Error(`No create*Adapter factory in "${packageName}" (dispatch="${dispatch}"). Exports: ${Object.keys(mod).join(", ")}`);
			}
			const factory = mod[factoryName] as (opts: Record<string, unknown>) => unknown;
			const clientOpts = await resolveAdapterClientOptions(
				packageName,
				args.client as Record<string, unknown> | undefined,
			);
			const client = factory(clientOpts);
			result = await fn(client, ...payloadArgs);
		}
		// A send whose row opted into messagingRecord lands in the party's thread
		// (best-effort — the send already happened; never fails the call).
		await recordOutboundMessagingSend(tool, args, context, result);
		return result;
	} catch (err) {
		// Adapters throw the normalized plain object ({code, message, retryable})
		// from `normalizeError` — a thrown plain object serializes to the opaque
		// "[object Object]" when the MCP layer String()-ifies it. Re-throw a real
		// Error carrying the message (and preserve the normalized fields for any
		// programmatic handler) so the failure surfaces readably.
		if (err instanceof Error) throw err;
		const ne = err as { message?: string; code?: string; retryable?: boolean };
		const wrapped = new Error(
			ne?.message ?? (typeof err === "string" ? err : "sdk tool failed"),
		);
		Object.assign(wrapped, ne);
		throw wrapped;
	}
}
