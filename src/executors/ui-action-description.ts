/**
 * @system tool-executor
 * @status handwritten
 */

import type { UiActionDescribeConfig } from "@teamscala/tool-executor-substrate/lib/types.ts";

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
