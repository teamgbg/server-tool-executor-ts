/**
 * @system tool-executor
 * @status handwritten
 */

const logger = getLogger();

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import { modelHasField } from "@teamscala/tool-executor-substrate/lib/prisma-meta.ts";
import { isSystemCaller } from "@teamscala/tool-executor-substrate/lib/system-caller.ts";
import type { ExecutionContext, OrpcExecutorConfig } from "@teamscala/tool-executor-substrate/lib/types.ts";

function isOrgFieldSet(
	where: Record<string, unknown>,
	orgField: string,
): boolean {
	if (where[orgField] !== undefined) return true;
	const parts = orgField.split(".");
	if (parts.length === 1) return false;
	let current: unknown = where;
	for (const part of parts) {
		if (typeof current !== "object" || current === null) return false;
		current = (current as Record<string, unknown>)[part];
		if (current === undefined) return false;
	}
	return true;
}

export function injectScopeFilter(
	where: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
	modelName?: string,
): void {
	const orgField = config.orgField || "organisation_id";
	const userField = config.userField || "user_id";

	if (config.scopeType === "public") return;

	// Admin / system bypass — no org/user filtering for cross-org dev access.
	// The system caller (gateway/dev/fleet, MCP_SYSTEM_USER_ID sentinel) is the
	// same full-access identity resolveCallerUser grants super-admin at the
	// router layer; BOTH scope layers must bypass it consistently or one stamps
	// organisation_id onto the WHERE while the other doesn't — reads return only
	// system-org rows and a cross-org updateMany returns count:0 (2026-06-16).
	if (context.isAdmin || isSystemCaller(context.userId)) return;

	// For org and user scopes, inject org filter if not already explicitly set.
	// validateAuth already verified context.organisationId exists.
	// Only inject if the model actually has the field (some models inherit org through relations).
	// Skip if organisation_id is already set in where (caller explicitly requested a specific org).
	if (context.organisationId) {
		const modelHasOrgField = modelName
			? modelHasField(modelName, orgField)
			: true;
		if (modelHasOrgField && !isOrgFieldSet(where, orgField)) {
			setNestedField(where, orgField, context.organisationId);
		}
	}

	// User scope additionally filters by user.
	// validateAuth already verified context.userId exists.
	// Only inject if the model actually has the field.
	if (config.scopeType === "user" && context.userId) {
		const modelHasUserField = modelName
			? modelHasField(modelName, userField)
			: true;
		if (modelHasUserField) {
			setNestedField(where, userField, context.userId);
		}
	}
}

/**
 * Set a value at a dotted path, creating nested objects as needed.
 * "organisation_id" → where.organisation_id = value
 * "stored_calendars.organisation_id" → where.stored_calendars = { organisation_id: value }
 */
export function setNestedField(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	if (!path.includes(".")) {
		obj[path] = value;
		return;
	}
	const parts = path.split(".");
	let current = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		if (!current[part] || typeof current[part] !== "object") {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastPart = parts[parts.length - 1];
	if (lastPart !== undefined) {
		current[lastPart] = value;
	}
}

export function addScopeToWhere(
	input: Record<string, unknown>,
	config: OrpcExecutorConfig,
	context: ExecutionContext,
	modelName?: string,
): Record<string, unknown> {
	const result = { ...input };
	const where = (result.where as Record<string, unknown>) || {};
	injectScopeFilter(where, config, context, modelName);
	result.where = where;
	return result;
}

export function applyFilterTransform(
	where: Record<string, unknown>,
	transform: { field: string; operator: string; dayOffset?: number },
	value: unknown,
): void {
	let processedValue = value;

	// Coerce booleans for numeric operators (gt, gte, lt, lte).
	// AI sends e.g. unreadOnly: true, but Prisma needs { unread_count: { gt: 0 } }
	// If false, skip the filter entirely — "not filtering" means return all records.
	const numericOperators = ["gt", "gte", "lt", "lte"];
	if (
		typeof value === "boolean" &&
		numericOperators.includes(transform.operator)
	) {
		if (!value) return; // false = no filter
		processedValue = 0;
	}

	// Coerce string/number values to boolean for eq operator on boolean fields.
	// AI may send "true"/"false" strings or 1/0 instead of actual booleans.
	if (transform.operator === "eq") {
		if (value === "true" || value === 1) processedValue = true;
		else if (value === "false" || value === 0) processedValue = false;
	}

	// Normalize date strings for range operators (gte, lte, gt, lt).
	// These operators are used on DateTime fields — Prisma needs full ISO-8601.
	// Plain equality (eq) filters pass through as-is.
	const dateOperators = ["gte", "lte", "gt", "lt"];
	if (typeof value === "string" && dateOperators.includes(transform.operator)) {
		const isPlainDate = !value.includes("T");
		if (isPlainDate) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) {
				logger.warn(
					`[Executor] Invalid date value: "${value}" for field "${transform.field}" — skipping`,
				);
				return;
			}
			if (transform.dayOffset) {
				date.setDate(date.getDate() + transform.dayOffset);
			}
			processedValue = date.toISOString();
		} else if (transform.dayOffset) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) {
				logger.warn(
					`[Executor] Invalid date value: "${value}" for field "${transform.field}" — skipping`,
				);
				return;
			}
			date.setDate(date.getDate() + transform.dayOffset);
			processedValue = date.toISOString();
		}
	}

	if (transform.operator === "eq") {
		where[transform.field] = processedValue;
	} else {
		// Build Prisma operator: { gte: value }, { lte: value }, etc.
		// Merges with existing operators on the same field (e.g. startDate gte + endDate lte)
		const existing = where[transform.field];
		if (existing && typeof existing === "object" && !Array.isArray(existing)) {
			(existing as Record<string, unknown>)[transform.operator] =
				processedValue;
		} else {
			where[transform.field] = { [transform.operator]: processedValue };
		}
	}
}
