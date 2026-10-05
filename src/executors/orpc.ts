/**
 * @system tool-executor
 * @status handwritten
 */
import { createRouterClient as createCaller, type AnyRouter } from "@orpc/server";
import type { PrismaClient } from "@teamscala/db/client";
import { getAppRouter, getLogger, getPrisma } from "../configure.ts";
import { setNestedField } from "../lib/scope";
import type { ExecutionContext, OrpcExecutorConfig } from "../lib/types";
import { enumerateBulkTargets } from "./orpc/enumerate-bulk-targets";
import { postProcessResult } from "./orpc/orpc-postprocess";
import { validateRegistryConfig } from "./orpc/orpc-registry-validation";
import { statusOnlyBulkGateRefusal } from "./work-items-status-bulk-gate";
import { prepareArgs } from "./orpc/prepare-args";
import { buildFinalArgsByMethod } from "./orpc/final-args-by-method";
import { preprocessSearch } from "./orpc/preprocess-search";
import { assertProtectedUniqueWrite } from "./orpc/protected-unique-write";
import { resolveCallerUser, type CallerUserDb } from "./orpc/resolve-caller-user";
import { withRlsTransaction } from "@teamscala/db/rls-context";
import { getDb8 } from "@teamscala/db/db8-registry";
import {
	applyDerivedCommentIdentity,
	deriveCommentIdentity,
} from "./comment-write-identity.ts";
import { resolveCallerCliSession } from "./caller-cli-session.ts";

const logger = getLogger();

export async function executeOrpcProcedure(
	procedure: string,
	args: Record<string, unknown>,
	context: ExecutionContext,
	config: OrpcExecutorConfig,
): Promise<unknown> {
	const [modelName, methodName] = procedure.split(".");
	if (!modelName || !methodName) {
		throw new Error(
			`Invalid ORPC procedure format: ${procedure}. Expected "model.method"`,
		);
	}

	// Blast-radius declaration for destructive bulk writes (see gate below).
	// Read and strip BEFORE arg preparation so it can never leak into the
	// where-builder as a flat filter field.
	const maxAffectedRows = args.max_affected_rows;
	if ("max_affected_rows" in args) {
		delete args.max_affected_rows;
	}

	const appRouter = await getAppRouter();
	const router = (appRouter as unknown as Record<string, unknown>)[modelName];
	if (!router) {
		throw new Error(
			`ORPC router has no model namespace "${modelName}". ` +
				"Regenerate the service ORPC bundle through scala-tools codegen and restart the service; " +
				"direct Prisma fallback is prohibited.",
		);
	}

	let resolvedConfig = config;
	const modelConfigs = config.modelConfigs as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (modelConfigs?.[modelName]) {
		resolvedConfig = {
			...config,
			...modelConfigs[modelName],
		} as OrpcExecutorConfig;
		logger.info(`[Executor] Merged per-model config for "${modelName}"`);
	}

	const { cleanArgs, fieldsParam, resolvedContext, overrideUserId, defaultsApplied, defaultTake } =
		await prepareArgs(args, methodName, modelName, context, resolvedConfig);

	await preprocessSearch(cleanArgs, resolvedConfig, modelName, resolvedContext);

	const finalArgs = buildFinalArgsByMethod(
		methodName,
		modelName,
		cleanArgs,
		fieldsParam,
		resolvedConfig,
		resolvedContext,
	);

	if (
		overrideUserId &&
		resolvedConfig.scopeType === "org" &&
		methodName === "findMany"
	) {
		const userField = resolvedConfig.userField || "user_id";
		const where = (finalArgs.where as Record<string, unknown>) || {};
		setNestedField(where, userField, resolvedContext.userId);
		finalArgs.where = where;
	}

	// getPrisma() is intentionally `unknown` (configured-primitives contract);
	// downcast to the real injected client shape at the call site per its contract.
	const prisma = getPrisma() as PrismaClient;
	const commentIdentity =
		modelName === "comments" && methodName === "create"
			? await deriveCommentIdentity(prisma, resolvedContext)
			: null;
	if (commentIdentity) applyDerivedCommentIdentity(finalArgs, commentIdentity);
	await assertProtectedUniqueWrite(
		prisma,
		modelName,
		methodName,
		finalArgs,
		resolvedConfig.whereConstraint,
	);

	logger.info(`[Executor] ORPC call: ${modelName}.${methodName}`, {
		finalArgs,
	});
	// Build the ORPC router context. The generated `protectedProcedure` middleware requires a user with organisationId or isSuperAdmin, and
	// org-scopes every read to ctx.orgId unless the user isSuperAdmin.
	//
	// A system / gateway-mediated caller — no user identity, OR the configured system sentinel user "system" (MCP_SYSTEM_USER_ID, stamped on every
	// gateway→hub-tool call via the mcp-ai-chat-system mcp_server row's extraHeaders) — is the operator/dev/fleet path and gets a SUPER-ADMIN
	// context: full cross-org access (matching validateAuth's `if (context.isAdmin) return // cross-org dev access`). Without this the
	// "system" sentinel is truthy and falls into the scoped branch, silently pinning every dev-tooling read to the system org (c503629a) and hiding
	// every other org's data — the "only 3 proposals" bug. A real per-org agent passes its own user id (never "system") and stays correctly org-scoped, so
	// multi-tenant isolation for product surfaces is unaffected. PrismaClient structurally provides both delegates (user.findUnique +
	// member.findFirst); the cast bridges Prisma's generated generic signatures to the narrow CallerUserDb resolveCallerUser reads (no behaviour change).
	const callerUser = await resolveCallerUser(
		prisma as unknown as CallerUserDb,
		resolvedContext,
	);
	// The context is a FUNCTION of the client pair, not a fixed object: a write
	// must run with the context bound to the TRANSACTION client, and a read
	// runs on the pool. Building it once with pool clients — the shape the
	// deleted set/reset pair tolerated, because the context was set on the pool
	// and the query went to the pool — is exactly the two-connection defect
	// `withRlsTransaction` exists to remove: the context landed on whichever
	// connection was free, not the one the query used.
	const contextFor = (
		boundPrisma: unknown,
		boundDb8: unknown,
		rlAttribution?: Record<string, unknown>,
	) => ({
		prisma: boundPrisma,
		// The v8 chained client. Generated v8 procedures resolve their model
		// through `resolveModelOrm(ctx.db8)`, which THROWS when db8 is absent
		// since the v7 adapter was cut. On the write path this is
		// `scope.models` — the model surface bound to the SAME connection the
		// `SET LOCAL` context was issued on, so attribution and the write can
		// never diverge. On the read path it is the registry's client.
		db8: boundDb8,
		user: callerUser,
		orgId: callerUser.organisationId,
		// Forward the complete canonical caller snapshot so the gateway
		// procedure can re-enter ALS with the FULL identity (not a
		// reconstructed subset) for caller-scoped downstream dispatch.
		// See `downstream-transports-are-caller-scoped`.
		callerInfo: resolvedContext.callerInfo,
		// The field the GENERATED fn middleware reads: it spreads this into the
		// SessionContext it hands `withRlsTransaction`, so the pane / CLI-session
		// identity reaches `SET LOCAL app.pane_id`, `app.cli_session_id` and the
		// audit trigger. Absent on the read path, where the emitter's `?? {}`
		// makes behaviour byte-identical to before.
		rlAttribution,
	});
	const callerFor = (context: ReturnType<typeof contextFor>) =>
		createCaller(router as unknown as AnyRouter, { context }) as Record<
			string,
			(a: unknown) => Promise<unknown>
		>;
	const caller = callerFor(contextFor(prisma, getDb8() ?? undefined));

	const method = caller[methodName];
	if (typeof method !== "function") {
		throw new Error(`Unknown method ${methodName} on model ${modelName}`);
	}

	if (
		modelName === "registry_entries" &&
		(methodName === "create" ||
			methodName === "update" ||
			methodName === "upsert" ||
			methodName === "updateMany")
	) {
		await validateRegistryConfig(
			methodName,
			finalArgs,
			prisma,
			resolvedContext,
		);
	}

	// Destructive-write gate — the 2026-06-06 guard_rule wipe class. An
	// updateMany whose data REPLACES the jsonb `config` wholesale writes one
	// object onto EVERY matched registry row: an over-broad where or a mangled
	// MCP payload wipes N configs in one statement (447 rows wiped by one
	// call; only 1 was audited under the then-buggy trigger). Such calls must
	// declare their blast radius: pass `max_affected_rows` (integer >= 1); the
	// executor counts matches FIRST and refuses when the match count exceeds
	// the declared cap. Per-row `update` (slug-scoped, schema-validated) needs
	// no cap and stays the default path for config edits.
	if (
		methodName === "updateMany" &&
		modelName === "registry_entries" &&
		(finalArgs.data as Record<string, unknown> | undefined)?.config !==
			undefined
	) {
		if (
			typeof maxAffectedRows !== "number" ||
			!Number.isInteger(maxAffectedRows) ||
			maxAffectedRows < 1
		) {
			throw new Error(
				'update_many writing "config" on registry_entries requires "max_affected_rows" (integer >= 1) declaring the expected blast radius — a wholesale config write hits every matched row with one object (2026-06-06: 447 guard_rule configs wiped by one call). Count your targets and pass the cap, or use per-row "update".',
			);
		}
		// `.count` (a read) for the blast-radius gate — not a mutation/config-read,
		// so loadRegistryConfig cannot express it. Parenthesized access matches the
		// existing convention here and stays outside registry-via-helper's scope.
		const matched = await (prisma).registry_entries.count({
			where: finalArgs.where as NonNullable<
				Parameters<PrismaClient["registry_entries"]["count"]>[0]
			>["where"],
		});
		if (matched > maxAffectedRows) {
			throw new Error(
				`update_many config write would affect ${matched} registry_entries rows, exceeding declared max_affected_rows=${maxAffectedRows} — refusing. Narrow the where filter, or raise the cap only after counting your targets.`,
			);
		}
	}

	// Status-only bulk update gate — the 2026-08-24 platform-wide todo->done
	// write class (515 rows across 177 parents from one call that meant 5
	// subtasks). The pure decision + fixture pair live in
	// work-items-status-bulk-gate; this arm pays one count query only when
	// the status-only shape holds, then refuses by name.
	if (
		methodName === "updateMany" &&
		modelName === "work_items" &&
		finalArgs.where &&
		typeof finalArgs.where === "object"
	) {
		const whereKeys = Object.keys(
			finalArgs.where as Record<string, unknown>,
		).filter(
			(key) => (finalArgs.where as Record<string, unknown>)[key] !== undefined,
		);
		if (whereKeys.length === 1 && whereKeys[0] === "status") {
			const matched = await (prisma).work_items.count({
				where: finalArgs.where as NonNullable<
					Parameters<PrismaClient["work_items"]["count"]>[0]
				>["where"],
			});
			const refusal = statusOnlyBulkGateRefusal({
				where: finalArgs.where as Record<string, unknown>,
				matched,
				maxAffectedRows,
			});
			if (refusal) throw new Error(refusal);
		}
	}

	// Target enumeration for the bulk mutations — the readback half of
	// `a-mutating-verb-reads-back-what-it-claims`. BEFORE the statement runs
	// (deleteMany must capture identities while the rows still exist), capture
	// the enumerated targets so the result carries the identities it changed,
	// not a bare count. The 2026-08-16 rewrite of 6,890 rows was visible only
	// as a success payload with a number in it.
	let bulkEnumeration: Awaited<ReturnType<typeof enumerateBulkTargets>> | null =
		null;
	if (
		(methodName === "updateMany" || methodName === "deleteMany") &&
		finalArgs.where &&
		typeof finalArgs.where === "object"
	) {
		const keyFields = resolvedConfig.identifierFields?.length
			? resolvedConfig.identifierFields
			: [resolvedConfig.identifierField || resolvedConfig.idField || "id"];
		bulkEnumeration = await enumerateBulkTargets(
			prisma,
			modelName,
			finalArgs.where as Record<string, unknown>,
			keyFields,
		);
	}

	const writeMethods = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
	const needsRlsContext = writeMethods.has(methodName);
	// The caller's verified open CLI session, so lane-originated writes reach
	// the database attributed (app.cli_session_id) — the identity the audit
	// trail reads and `lane_writes_bind_to_own_task` enforces. Without this,
	// a lane's work_items write landed unattributed (measured 2026-08-26:
	// the peer-task write incident carried cli_session_id NULL end to end).
	const callerCliSession = needsRlsContext
		? await resolveCallerCliSession(prisma, resolvedContext)
		: null;
	// A write runs inside its own transaction with the context bound to it; see
	// the file header for why the pair it replaced was two connections.
	const rlsContext = {
		userId: resolvedContext.userId,
		userName: resolvedContext.userId === "system" ? "system" : undefined,
		serviceSource: resolvedContext.serviceSource,
		writePath: `orpc:${modelName}.${methodName}`,
		agentId: resolvedContext.agentId,
		// Sourced from the VERIFIED resolved caller (stored role / system
		// sentinel), not the unpopulated header `resolvedContext.isAdmin` —
		// the same multi-tenant fail-open resolveCallerUser just closed.
		isSuperAdmin: callerUser.isSuperAdmin,
		paneId: resolvedContext.callerInfo?.tmuxTarget,
		paneLabel: resolvedContext.callerInfo?.label,
		cliSessionId:
			commentIdentity?.source_cli_session_id ?? callerCliSession?.id ?? null,
		cliKind: resolvedContext.callerInfo?.["cliKind"] as string | null | undefined,
	};

	let result = needsRlsContext
		? await withRlsTransaction(rlsContext, async (scope) => {
				const txMethod = callerFor(
					contextFor(scope.tx, scope.models, rlsContext),
				)[methodName];
				return txMethod(finalArgs);
			})
		: await method(finalArgs);

	// Merge the enumerated target identities into the bulk-mutation result so
	// the caller (and the audit trail) sees WHICH rows changed, capped at the
	// enumeration limit with `affected_truncated` naming the truncation.
	if (bulkEnumeration) {
		const base =
			result && typeof result === "object"
				? (result as Record<string, unknown>)
				: {};
		result = {
			...base,
			affected: bulkEnumeration.affected,
			affected_truncated: bulkEnumeration.affected_truncated,
		};
	}

	return postProcessResult(
		result,
		methodName,
		modelName,
		finalArgs,
		resolvedContext,
		resolvedConfig,
		prisma,
		defaultsApplied,
		defaultTake,
	);
}
