/**
 * @system mcp-infrastructure
 * @status handwritten
 */

export function isObjectWithKeys(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value as Record<string, unknown>).length > 0
	);
}

export function buildStrictBulkMutationArgs(
	methodName: "updateMany" | "deleteMany",
	input: Record<string, unknown>,
): { where: Record<string, unknown>; data?: Record<string, unknown> } {
	const label = methodName === "updateMany" ? "update_many" : "delete_many";
	const strays = Object.keys(input).filter(
		(key) => key !== "where" && key !== "data",
	);
	const example =
		methodName === "updateMany"
			? 'where: {status: "pending"}, data: {title: "New title"}'
			: 'where: {status: "pending"}';

	const where = isObjectWithKeys(input.where)
		? { ...(input.where as Record<string, unknown>) }
		: {};
	if (strays.length > 0) {
		throw new Error(
			`"${label}" accepts only \`where\`${methodName === "updateMany" ? " and \`data\`" : ""} — received top-level ${strays.join(", ")}. ` +
				`Top-level columns are FILTERS for list/count and SET-VALUES for update, so their meaning on a bulk mutation is ambiguous and they are refused. ` +
				`Move filters into \`where\`${methodName === "updateMany" ? " and fields to set into \`data\`" : ""}: {${example}}. ` +
				`(For a single row, use the \`${methodName === "updateMany" ? "update" : "delete"}\` action with its id.)`,
		);
	}
	if (Object.keys(where).length === 0) {
		throw new Error(
			`"${label}" requires \`where\` — an object of column filters naming the rows to ${methodName === "updateMany" ? "update" : "delete"}, e.g. {${example}}. ` +
				`An unfiltered bulk mutation is refused: on 2026-08-16 one flat bulk-mutation call rewrote 6,890 work_items titles while reporting success.`,
		);
	}
	if (methodName === "updateMany") {
		const data = isObjectWithKeys(input.data)
			? { ...(input.data as Record<string, unknown>) }
			: {};
		if (Object.keys(data).length === 0) {
			throw new Error(
				`"update_many" requires \`data\` — an object naming the fields to SET and their new values, e.g. {data: {title: "New title"}}. ` +
				`Pass set-values ONLY inside \`data\` and filters ONLY inside \`where\`.`,
			);
		}
		return { where, data };
	}
	return { where };
}
