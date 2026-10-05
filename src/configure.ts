/**
 * @system tool-executor
 * @status handwritten
 */

// 1. Locally-defined contract — NEVER import from the upstream package.
export interface InjectedLogger {
	error: (msg: string, ctx?: Record<string, unknown>) => void;
	warn: (msg: string, ctx?: Record<string, unknown>) => void;
	info: (msg: string, ctx?: Record<string, unknown>) => void;
	debug: (msg: string, ctx?: Record<string, unknown>) => void;
}

// 2. Default fallback. No-op so primitives load cleanly when bootloader
//    hasn't called configure() yet (tests, CLI invocations, etc.).
//    MUTABLE SINGLETON, never rebound: modules capture
//    `const logger = getLogger()` at import time — BEFORE the bootloader
//    calls configure() — so a configure() that swaps in a NEW logger object
//    leaves every captured reference reading the noop forever. Measured
//    live 2026-08-21: every tool-executor log line was silent on the
//    deployed gateway while configure() HAD run, because 14 modules held
//    the pre-configure noop. configure() mutates this one shared object,
//    so a capture made at any time observes the live logger.
const defaultLogger: InjectedLogger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
};

export type InjectedPrismaProvider = () => unknown;
export type InjectedAppRouterProvider = () => unknown;
// Server-client provider — synchronous getter returning the ORPC server
// client bound to the AppRouter; call sites read it as
// `client.<table>.<procedure>(args)`. Local-only view: the real typed shape
// lives in @teamscala/orpc and cannot be imported here (tier crossing per
// vertical-dependency-only).
/** Dynamic model-access view; results are unknown — rows narrowed per call site. */
export interface InjectedServerClient {
	[table: string]: {
		[method: string]: (args?: unknown) => Promise<unknown>;
	};
}
export type InjectedServerClientProvider = () => InjectedServerClient;
export type Prisma = unknown;

// Caller-identity + secret collaborators — locally-defined contracts (tier
// crossing per vertical-dependency-only: the real factories live in tier-2
// siblings and arrive via configure() from the boot layer, same as the ORPC
// types above). The host-command-bus invoker injection that shared this
// section retired with the bus (2026-09-19).
/** Local structural view of the caller-identity record the gateway stamps
 *  into AsyncLocalStorage — only the fields tool-executor reads. */
export interface InjectedCallerInfo {
	userId?: string | null;
	organisationId?: string | null;
	agentId?: string | null;
	orchestratorSessionId?: string | null;
	tmuxTarget?: string | null;
}
export type InjectedGetCallerContext = () => InjectedCallerInfo;
export type InjectedDecryptSecretConfig = (raw: unknown) => unknown;

const noopPrismaProvider: InjectedPrismaProvider = () => {
	throw new Error("tool-executor: prisma provider not configured");
};
const noopAppRouterProvider: InjectedAppRouterProvider = () => {
	throw new Error("tool-executor: app router provider not configured");
};
const noopServerClientProvider: InjectedServerClientProvider = () => {
	throw new Error("tool-executor: server client provider not configured");
};
// Caller identity is a QUERY, not an action: unwired, the honest answer is
// the null-identity record (the same shape an ALS read returns outside any
// context run) — caller-scoped procedures then see an unidentified caller,
// as designed.
const noopGetCallerContext: InjectedGetCallerContext = () => ({
	userId: null,
	organisationId: null,
	agentId: null,
	orchestratorSessionId: null,
	tmuxTarget: null,
});
const noopDecryptSecretConfig: InjectedDecryptSecretConfig = (_raw: unknown) => {
	throw new Error(
		"tool-executor: secret decryption not configured — the boot layer must " +
			"inject decryptSecretConfig (bootloader-injection-contract)",
	);
};

// 3. Module-level state. configure() rebinds at boot — EXCEPT the logger,
//    which keeps the default singleton's identity: configure() Object.assigns
//    INTO it (see the comment above) so pre-configure captures go live.
const _logger: InjectedLogger = defaultLogger;
let _getPrisma: InjectedPrismaProvider = noopPrismaProvider;
let _getAppRouter: InjectedAppRouterProvider = noopAppRouterProvider;
let _getServerClient: InjectedServerClientProvider = noopServerClientProvider;
let _scalaDevKey: string | undefined;
let _getCallerContext: InjectedGetCallerContext = noopGetCallerContext;
let _decryptSecretConfig: InjectedDecryptSecretConfig = noopDecryptSecretConfig;

// 4. Bootloader calls this exactly once before any tier-1+ code runs.
//    The logger is MUTATED IN PLACE (never rebound): modules that captured
//    getLogger() at import time hold the singleton's identity, so assigning
//    through it — not replacing it — is what makes their captures go live.
export function configure(opts: {
	logger?: InjectedLogger;
	getPrisma?: InjectedPrismaProvider;
	getAppRouter?: InjectedAppRouterProvider;
	getServerClient?: InjectedServerClientProvider;
	scalaDevKey?: string;
	getCallerContext?: InjectedGetCallerContext;
	decryptSecretConfig?: InjectedDecryptSecretConfig;
}): void {
	if (opts.logger) Object.assign(_logger, opts.logger);
	if (opts.getPrisma) _getPrisma = opts.getPrisma;
	if (opts.getAppRouter) _getAppRouter = opts.getAppRouter;
	if (opts.getServerClient) _getServerClient = opts.getServerClient;
	if (opts.scalaDevKey !== undefined) _scalaDevKey = opts.scalaDevKey;
	if (opts.getCallerContext) _getCallerContext = opts.getCallerContext;
	if (opts.decryptSecretConfig) _decryptSecretConfig = opts.decryptSecretConfig;
}

// 5. Internal getters — ALL tool-executor call sites use these.
export function getLogger(): InjectedLogger {
	return _logger;
}

export function getPrisma(): unknown {
	return _getPrisma();
}

export function getAppRouter(): unknown {
	return _getAppRouter();
}

export function getServerClient(): InjectedServerClient {
	return _getServerClient();
}

export function getScalaDevKey(): string | undefined {
	return _scalaDevKey;
}

export function getCallerContext(): InjectedCallerInfo {
	return _getCallerContext();
}

export function getDecryptSecretConfig(): InjectedDecryptSecretConfig {
	return _decryptSecretConfig;
}
