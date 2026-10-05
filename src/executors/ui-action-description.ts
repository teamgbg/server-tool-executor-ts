/**
 * @system tool-executor
 * @status handwritten — none derivable: the projection is a serve-time concern
 */

import type { UiActionDescribeConfig } from "../lib/types";

export function renderUiActionDescription(
	baseDescription: string,
	describe: UiActionDescribeConfig | undefined,
	rows: Array<Record<string, unknown>>,
): string {
	if (!describe) return baseDescription;
	if (rows.length === 0) return baseDescription;
	const list = rows
		.map((row) => `- "${String(row[describe.labelField] ?? "")}" (id: ${String(row.id)})`)
		.join("\n");
	return `${baseDescription} ${describe.heading}\n${list}`;
}
