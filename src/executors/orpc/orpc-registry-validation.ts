/**
 * @system tool-executor
 * @status handwritten
 */

const uuidv7 = () => Bun.randomUUIDv7();

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import type { ExecutionContext } from "@teamscala/tool-executor-substrate/lib/types.ts";
import type { PrismaClient } from "@teamscala/db/client";
import { validateRow } from "@teamscala/db-validation/validate-row";
import { validateJsonSchema } from "@teamscala/formatters/validate-json-schema";

const logger = getLogger();

export async function validateRegistryConfig(
	operation: "create" | "update" | "upsert" | "updateMany",
	args: Record<string, unknown>,
	prisma: PrismaClient,
	context: ExecutionContext,
): Promise<void> {
	if (
		operation !== "create" &&
		operation !== "update" &&
		operation !== "upsert" &&
		operation !== "updateMany"
	) {
		return;
	}

	let entryType: string | undefined;
	let entrySlug: string | undefined;
	let entryConfig: unknown;

	if (operation === "create" || operation === "upsert") {
		const data = args.data as Record<string, unknown> | undefined;
		entryType = data?.type as string | undefined;
		entrySlug = data?.slug as string | undefined;
		entryConfig = data?.config;
	} else if (operation === "update" || operation === "updateMany") {
		const data = args.data as Record<string, unknown> | undefined;
		entryConfig = data?.config;
		if (args.where && typeof args.where === "object") {
			const where = args.where as Record<string, unknown>;
			entryType = where.type as string | undefined;
			entrySlug = where.slug as string | undefined;
			if (
				operation === "update" &&
				entryConfig !== undefined &&
				(!entryType || !entrySlug)
			) {
				const existing = await prisma.registry_entries.findFirst({
					where,
					select: { type: true, slug: true },
				});
				entryType = existing?.type;
				entrySlug = existing?.slug;
			}
		}
	}

	// A slug-less bulk write (updateMany with a type-only where) still validates
	// against the type's __default__ schema — the 2026-06-06 guard_rule wipe was
	// exactly a type-only updateMany whose mangled config skipped this gate
	// because the slug-less early-return treated "no slug" as "nothing to check".
	if (!entryType || entryConfig === undefined) {
		return;
	}
	validateRow(entryType, entryConfig);
	if (!entrySlug && operation !== "updateMany") {
		return;
	}

	const schemaEntry = await prisma.registry_config_schemas.findFirst({
		where: {
			type: entryType,
			OR: entrySlug
				? [{ slug: entrySlug }, { slug: "__default__" }]
				: [{ slug: "__default__" }],
		},
		orderBy: [{ slug: "desc" }],
	});

	if (!schemaEntry?.schema) {
		return;
	}

	const validationResult = validateJsonSchema(
		entryConfig,
		schemaEntry.schema as Record<string, unknown>,
	);
	if (validationResult.valid) {
		return;
	}

	const validationErrors = validationResult.errors
		.map((e: { path: string; message: string }) => `${e.path}: ${e.message}`)
		.join("; ");

	const entityTitle = `${entryType}:${entrySlug}`;
	const userId = context.userId || "system";
	const userName = "MCP Tool Server";
	const { loadRegistryConfig } = await import(
		"@teamscala/db/registry/load-config"
	);
	const { PlatformIdentitySchema } = await import(
		"@teamscala/db-validation/registry-schemas/platform-identity"
	);
	// Platform org id is a registry value (registries-are-source-of-truth).
	const platformOrgId = (
		await loadRegistryConfig(
			"config",
			"platform-identity",
			PlatformIdentitySchema,
		)
	).platformOrganisationId;
	const orgId = context.organisationId || platformOrgId;

	try {
		await prisma.audit_trail.create({
			data: {
				id: uuidv7(),
				user_id: userId,
				user_name: userName,
				action: "validation_failed",
				entity_type: "RegistryEntry",
				entity_id: "unknown",
				entity_title: entityTitle,
				// No prior state on a validation failure; omit (stored as NULL) —
				// Prisma's nullable Json input rejects bare `null`.
				changes_before: undefined,
				changes_after: JSON.stringify({
					type: entryType,
					slug: entrySlug,
					config: entryConfig,
					validation_errors: validationErrors,
				}),
				ip_address: null,
				user_agent: null,
				organisation_id: orgId,
				is_impersonation: false,
				impersonator_user_id: null,
				impersonator_user_name: null,
				service_source: "mcp-ai-chat-system",
				agent_id: context.agentId || null,
			},
		});
	} catch (auditError) {
		logger.error("[Executor] Failed to write validation_failed audit entry", {
			auditError,
		});
	}

	throw new Error(
		`Registry config validation failed for ${entityTitle}: ${validationErrors}`,
	);
}
