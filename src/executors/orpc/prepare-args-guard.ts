/**
 * @system mcp-infrastructure
 * @status handwritten
 */

export function requireCompleteIdentity(
	input: Record<string, unknown>,
	keyFields: string[],
	action: string,
): void {
	if (keyFields.length < 2) return;
	const present = keyFields.filter((field) => input[field] !== undefined);
	if (present.length > 0 && present.length !== keyFields.length) {
		throw new Error(
			`"${action}" requires all composite identity fields: ${keyFields.join(", ")}`,
		);
	}
}

export function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function rejectForbiddenFieldValues(
	value: unknown,
	forbidden: Record<string, unknown[]> | undefined,
	path = "input",
): void {
	if (!forbidden || !value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			rejectForbiddenFieldValues(value[index], forbidden, `${path}[${index}]`);
		}
		return;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		const denied = forbidden[key] ?? [];
		if (denied.some((candidate) => sameValue(candidate, child))) {
			throw new Error(
				`${path}.${key} cannot be ${JSON.stringify(child)} on this generated database tool; use the owning local capability instead`,
			);
		}
		rejectForbiddenFieldValues(child, forbidden, `${path}.${key}`);
	}
}

export function applyWhereConstraint(
	args: Record<string, unknown>,
	constraint: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!constraint || Object.keys(constraint).length === 0) return args;
	const existing = args.where as Record<string, unknown> | undefined;
	return {
		...args,
		where: existing && Object.keys(existing).length > 0
			? { AND: [existing, constraint] }
			: constraint,
	};
}

