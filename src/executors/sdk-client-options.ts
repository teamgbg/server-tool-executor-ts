/**
 * @system tool-executor
 * @status handwritten
 */

import type { RegistryKeyFor } from "@teamscala/db/registry/generated/registry-type";
import * as v from "valibot";
import { getDecryptSecretConfig, getLogger } from "../configure.ts";
import { loadToolExecutorCacheControls } from "../lib/cache-controls.ts";

const logger = getLogger();

/**
 * Resolve the adapter package name for an SDK tool: the sdk name is the
 * package name minus the "@teamscala/" scope with dashes as underscores
 * ("@teamscala/api-resend" → "api_resend"), so resolving back is
 * "@teamscala/" + dashes-restored. A blanket "@teamscala/api-<sdk>" was the
 * bug (double-prefixed api-*, wrongly prefixed the rest); an explicit
 * packageName (registry-owned aliases like aws → object-storage) wins.
 */
export function sdkPackageName(sdkName: string, explicit?: string): string {
	return explicit && explicit.length > 0
		? explicit
		: `@teamscala/${sdkName.replace(/_/g, "-")}`;
}

/**
 * Resolve the options passed to an adapter's create*Adapter factory. Credentials
 * are baked into executor_config.client as { baseUrl, apiKeyEnv } by the
 * tool-generator; the api key is read from the environment at call time so the
 * model never sees it. A caller-supplied argsClient wins (explicit override).
 */
export function resolveSdkClientOptions(
	clientCfg: { baseUrl?: string; apiKeyEnv?: string } | undefined,
	argsClient: Record<string, unknown> | undefined,
	env: Record<string, string | undefined>,
): Record<string, unknown> {
	const cfg = clientCfg ?? {};
	const apiKey = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
	return {
		...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
		...(apiKey ? { apiKey } : {}),
		...(argsClient ?? {}),
	};
}

/**
 * Cached `config/sdk-adapter-definitions` row (the adapter inventory). The row
 * is slow-changing; a 60s TTL cache avoids a DB read per dispatch (hot-path per
 * `hot-path-resolutions-are-cached`).
 */
let _adapterDefsCache: {
	data: Record<string, unknown>;
	expiresAt: number;
} | null = null;

async function loadAdapterDefinitions(): Promise<Record<string, unknown>> {
	const now = Date.now();
	if (_adapterDefsCache && now < _adapterDefsCache.expiresAt) {
		return _adapterDefsCache.data;
	}
	try {
		const { adapterDefinitionsTtlMs } =
			await loadToolExecutorCacheControls();
		const { loadRegistryConfig } = await import(
			"@teamscala/db/registry/load-config"
		);
		const data = ((await loadRegistryConfig(
			"config",
			"sdk-adapter-definitions",
			// Permissive: the row is a free-form adapter map (gowa, aws, ...);
			// each entry's initConfig is resolved + validated by the adapter's
			// own create*Adapter factory, not here.
			v.record(v.string(), v.unknown()),
		)) ?? {}) as Record<string, unknown>;
		_adapterDefsCache = {
			data,
			expiresAt: now + adapterDefinitionsTtlMs,
		};
		return _adapterDefsCache.data;
	} catch (err) {
		logger.warn?.(
			`[sdk-executor] could not load sdk-adapter-definitions: ${err instanceof Error ? err.message : String(err)}`,
		);
		return _adapterDefsCache?.data ?? {};
	}
}

async function loadSecretField(slug: string, key: string): Promise<string> {
	const { loadRegistryConfig } = await import("@teamscala/db/registry/load-config");
	// eslint-disable
	const raw = await loadRegistryConfig(
		"secret",
		slug as RegistryKeyFor<"secret">,
		v.record(v.string(), v.unknown()),
	);
	const decrypted = getDecryptSecretConfig()(raw as never) as Record<string, unknown>;
	const value = decrypted[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`SDK adapter secret '${slug}.${key}' is not configured`);
	}
	return value;
}

/**
 * Resolve an adapter's client options from its `initConfig` (field → env-var
 * name) in `config/sdk-adapter-definitions`, reading each env var at call time
 * so secrets never reach the model. Works for every adapter shape (GOWA
 * `{baseUrl,username,password}`, resend `{apiKey}`, aws
 * `{region,accessKeyId,secretAccessKey}`). A caller-supplied override wins
 * per-field. Replaces the old `{baseUrl, apiKeyEnv}`-only resolution that could
 * not supply username/password (or any non-apiKey field), leaving every SDK
 * tool to build a credential-less client.
 */
export async function resolveAdapterClientOptions(
	packageName: string,
	override?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const defs = await loadAdapterDefinitions();
	const entry = Object.values(defs).find(
		(e) => (e as { packageName?: string })?.packageName === packageName,
	) as
		| {
				initConfig?: Record<string, string>;
				initSecrets?: Record<string, string | { slug: string; key?: string }>;
		  }
		| undefined;
	const initConfig = entry?.initConfig ?? {};
	const opts: Record<string, unknown> = {};
	for (const [field, envVar] of Object.entries(initConfig)) {
		if (typeof envVar === "string") {
			const envVal = process.env[envVar];
			if (envVal !== undefined && envVal !== "") opts[field] = envVal;
		}
	}
	Object.assign(opts, await resolveSdkSecretOptions(entry?.initSecrets, loadSecretField));
	if (override) {
		for (const [k, val] of Object.entries(override)) opts[k] = val;
	}
	return opts;
}

/**
 * Resolve adapter factory fields from sealed secret rows. The adapter inventory
 * owns the field-to-secret mapping; callers cannot supply or observe credentials.
 */
export async function resolveSdkSecretOptions(
	refs: Record<string, string | { slug: string; key?: string }> | undefined,
	load: (slug: string, key: string) => Promise<string>,
): Promise<Record<string, string>> {
	const options: Record<string, string> = {};
	for (const [field, ref] of Object.entries(refs ?? {})) {
		const slug = typeof ref === "string" ? ref : ref.slug;
		const key = typeof ref === "string" ? "token" : (ref.key ?? "token");
		options[field] = await load(slug, key);
	}
	return options;
}
