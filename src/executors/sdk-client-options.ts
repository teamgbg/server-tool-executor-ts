/**
 * @system tool-executor
 * @status handwritten
 */

import type { RegistryKeyFor } from "@teamscala/db/registry/generated/registry-type";
import * as v from "valibot";
import { getDecryptSecretConfig, getLogger } from "../configure.ts";
import { loadToolExecutorCacheControls } from "../lib/cache-controls.ts";

const logger = getLogger();

export function sdkPackageName(sdkName: string, explicit?: string): string {
	return explicit && explicit.length > 0
		? explicit
		: `@teamscala/${sdkName.replace(/_/g, "-")}`;
}

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
