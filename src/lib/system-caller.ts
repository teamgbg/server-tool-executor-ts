/**
 * @system tool-executor
 * @status handwritten
 */

/** The sentinel user id presented by internal platform system actions. */
export const SYSTEM_USER_ID = "system";

/**
 * True ONLY for the explicit "system" sentinel user id — an internal platform
 * action authenticated via the loopback bearer. A missing/undefined user id is
 * NOT the system caller (anonymous → must fail closed). A real per-org user id
 * (never "system") stays org-scoped.
 */
export function isSystemCaller(userId: string | undefined): boolean {
	return userId === SYSTEM_USER_ID;
}
