/**
 * @system tool-executor
 * @status handwritten
 */

/**
 * A status-only bulk update on work_items is the platform-wide write class
 * (measured 2026-08-24: one update_many with `where: {status: 'todo'}` and
 * `data: {status: 'done'}` matched 515 rows across 177 parents — the caller
 * meant 5 subtasks of one lane). The filter names no scope, so it matches
 * every row with that status on the platform. Such a call must declare its
 * blast radius (`max_affected_rows`, counted first) — the same contract the
 * registry_entries config gate enforces for the 2026-06-06 wipe.
 *
 * Pure: the caller resolves `matched` with one count query only when the
 * status-only shape holds (scoped wheres never pay the count), then this
 * function decides. A refusal is a complete error message naming the count
 * and the remedy (`friction-is-a-stop-condition`).
 */
export function statusOnlyBulkGateRefusal(input: {
	where?: Record<string, unknown>;
	matched: number;
	maxAffectedRows?: unknown;
}): string | null {
	const where = input.where;
	if (!where || typeof where !== "object") return null;
	const whereKeys = Object.keys(where).filter((key) => where[key] !== undefined);
	const statusOnly = whereKeys.length === 1 && whereKeys[0] === "status";
	if (!statusOnly) return null;

	const cap = input.maxAffectedRows;
	if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
		return `update_many on work_items with a status-only filter requires "max_affected_rows" (integer >= 1) declaring the expected blast radius — the filter matches ${input.matched} row(s) platform-wide (2026-08-24: 515 rows across 177 parents flipped todo->done by one call that meant 5 subtasks). Scope by parent_id or count your targets and pass the cap.`;
	}
	if (input.matched > cap) {
		return `update_many status write would affect ${input.matched} work_items rows, exceeding declared max_affected_rows=${cap} — refusing. Narrow the where filter (parent_id), or raise the cap only after counting your targets.`;
	}
	return null;
}
