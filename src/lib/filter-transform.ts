/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";

const logger = getLogger();

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
