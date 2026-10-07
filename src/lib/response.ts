/**
 * @system tool-executor
 * @status handwritten
 */




import { getLogger } from "@teamscala/tool-executor-substrate/configure.ts";
import type { DynamicPrismaClient } from "@teamscala/tool-executor-substrate/lib/types.ts";

const logger = getLogger();

const MAX_RESPONSE_SIZE = 20 * 1024; // 20KB — ~5,000 tokens backstop (mcp-result-budget)

export function normalizeJsonResponse<T>(value: T): T {
	const serialized = JSON.stringify(value, (_key, child) =>
		typeof child === "bigint" ? child.toString() : child,
	);
	if (serialized === undefined) return value;
	return JSON.parse(serialized) as T;
}

export function compactTranscriptFields(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;

	const wrapper = result as Record<string, unknown>;

	// Handle ORPC response wrapper: { success, data: {...} }
	if (
		wrapper.success !== undefined &&
		wrapper.data &&
		typeof wrapper.data === "object"
	) {
		return {
			...wrapper,
			data: compactTranscriptInRecord(wrapper.data as Record<string, unknown>),
		};
	}

	// Direct record
	if (!Array.isArray(result)) {
		return compactTranscriptInRecord(wrapper);
	}

	return result;
}

function compactTranscriptInRecord(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...record };

	for (const [key, value] of Object.entries(result)) {
		// Only process string fields that look like JSON arrays (transcripts are stored as JSON strings)
		if (typeof value !== "string" || !value.startsWith("[")) continue;

		try {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed) || parsed.length === 0) continue;

			// Check if this looks like a transcript: array of {speaker, text, timestamp}
			const first = parsed[0];
			if (!first?.speaker?.display_name || !first?.text || !first?.timestamp)
				continue;

			// Compact: "[HH:MM:SS] Speaker Name: text"
			const lines: string[] = [];
			for (const entry of parsed) {
				const name = entry.speaker?.display_name || "Unknown";
				const time = entry.timestamp || "";
				const text = entry.text || "";
				lines.push(`[${time}] ${name}: ${text}`);
			}

			result[key] = lines.join("\n");
			logger.info(
				`[Executor] Compacted ${key}: ${value.length.toLocaleString()} chars → ${(result[key] as string).length.toLocaleString()} chars (${Math.round((1 - (result[key] as string).length / value.length) * 100)}% reduction)`,
			);
		} catch {
			// Not valid JSON — leave as-is
		}
	}

	return result;
}

function isChannelMessageResultShape(obj: unknown): boolean {
	if (!obj || typeof obj !== "object") return false;
	const r = obj as Record<string, unknown>;
	// `delivery_status` is the discriminator of SendOrchestratorMessageResult;
	// `runId` + `delivered_text` confirm it is a channel delivery receipt and
	// not unrelated data that happens to carry a like-named field.
	return (
		r.delivery_status !== undefined &&
		(r.runId !== undefined || r.delivered_text !== undefined)
	);
}

export function isChannelMessageResult(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	if (isChannelMessageResultShape(result)) return true;
	const wrapper = result as Record<string, unknown>;
	// ORPC wrapper: { success, data: {...} | [...] }
	if (wrapper.success !== undefined && wrapper.data !== undefined) {
		if (isChannelMessageResultShape(wrapper.data)) return true;
		// A list of delivery receipts (e.g. a send-history read) — exempt when
		// every element is a channel receipt, so the message bodies render in full.
		if (Array.isArray(wrapper.data) && wrapper.data.length > 0) {
			return wrapper.data.every((e) => isChannelMessageResultShape(e));
		}
	}
	return false;
}

export function truncateLargeResponse(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	result = normalizeJsonResponse(result);

	// Channel-message delivery results render verbatim — never paginate a
	// delivery receipt (it would hide the message content). See isChannelMessageResult.
	if (isChannelMessageResult(result)) return result;

	// Check response size
	const jsonStr = JSON.stringify(result);
	if (jsonStr.length <= MAX_RESPONSE_SIZE) return result;

	// Try to find and truncate arrays
	const wrapper = result as Record<string, unknown>;

	// Handle ORPC response wrapper: { success, data: [...] }
	if (wrapper.success !== undefined && wrapper.data !== undefined) {
		const data = wrapper.data;
		if (Array.isArray(data) && data.length > 0) {
			// Binary search for the max items that fit
			const truncated = truncateArrayToFit(data, MAX_RESPONSE_SIZE - 200); // leave room for wrapper
			if (truncated.length < data.length) {
				logger.info(
					`[Response] Truncated large response: ${data.length} → ${truncated.length} items`,
				);
				return {
					...wrapper,
					data: truncated,
					_truncated: {
						originalCount: data.length,
						returnedCount: truncated.length,
						hint: `Showing ${truncated.length} of ${data.length} results. Use take/skip to paginate.`,
					},
				};
			}
		}
	}

	// Handle direct array response
	if (Array.isArray(result) && result.length > 0) {
		const truncated = truncateArrayToFit(result, MAX_RESPONSE_SIZE - 100);
		if (truncated.length < result.length) {
			logger.info(
				`[Response] Truncated large array: ${result.length} → ${truncated.length} items`,
			);
			return {
				items: truncated,
				_truncated: {
					originalCount: result.length,
					returnedCount: truncated.length,
					hint: `Showing ${truncated.length} of ${result.length} results. Use take/skip to paginate.`,
				},
			};
		}
	}

	// The ceiling holds for EVERY shape, not only the ones an array can shrink.
	// Pagination is exhausted (or was never available), so passing the value on
	// would be the report of a bound never measured — withhold it with the size
	// and the narrowing that actually reduces it.
	const bounded = JSON.stringify(result).length;
	if (bounded > MAX_RESPONSE_SIZE) {
		logger.warn(
			`[Response] Withheld ${bounded}-byte result: no array to paginate below the ${MAX_RESPONSE_SIZE}-byte ceiling`,
		);
		return {
			_oversized: {
				originalBytes: bounded,
				reason: `Result is ${bounded} bytes and cannot be paginated below the ${MAX_RESPONSE_SIZE}-byte ceiling. Narrow the query — select fewer fields, take fewer rows, or filter tighter.`,
			},
		};
	}

	return result;
}

function truncateArrayToFit(arr: unknown[], maxSize: number): unknown[] {
	let low = 1;
	let high = arr.length;
	let best = arr.length;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const size = JSON.stringify(arr.slice(0, mid)).length;

		if (size <= maxSize) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	// Apply minimum item count only when those items actually fit within the size limit.
	// Without this check, the minimum override can force returning items that exceed maxSize.
	const minItems = Math.min(20, arr.length);
	const minSize = JSON.stringify(arr.slice(0, minItems)).length;
	return arr.slice(
		0,
		minSize <= maxSize ? Math.max(best, minItems) : Math.max(best, 1),
	);
}

export async function executeWithCount(
	prisma: DynamicPrismaClient,
	modelName: string,
	findManyArgs: Record<string, unknown>,
	findManyResult: unknown,
): Promise<unknown> {
	// Extract items from ORPC response wrapper
	let items: unknown[];
	const wrapper = findManyResult as Record<string, unknown>;
	if (wrapper?.success !== undefined && Array.isArray(wrapper?.data)) {
		items = wrapper.data;
	} else if (Array.isArray(findManyResult)) {
		items = findManyResult;
	} else {
		return findManyResult;
	}

	const limit = findManyArgs.take as number | undefined;

	// Run count directly via Prisma (no ORPC count procedure)
	try {
		const model = prisma[modelName];
		if (model?.count) {
			const total = await model.count({ where: findManyArgs.where });
			return {
				success: true,
				data: {
					items,
					total,
					limit,
					hasMore: limit ? items.length >= limit : false,
				},
				meta: { operation: "findMany", timestamp: new Date().toISOString() },
			};
		}
	} catch (e) {
		logger.warn(
			`[Executor] Count failed for ${modelName}, returning without count`,
			{ error: e },
		);
	}

	return findManyResult;
}
