/**
 * @system tool-executor
 * @status handwritten
 */

export const SYSTEM_USER_ID = "system";

export function isSystemCaller(userId: string | undefined): boolean {
	return userId === SYSTEM_USER_ID;
}
