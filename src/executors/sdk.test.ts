// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertSdkAdapterResolvable, executeSdkTool } from "./sdk.ts";
import {
	resolveSdkClientOptions,
	resolveSdkSecretOptions,
	sdkPackageName,
} from "./sdk-client-options.ts";

const stubbedAdapterModules = new Map<string, Record<string, unknown>>();

describe("sdkPackageName", () => {
	test("api-* package: underscores restore to dashes, no double prefix", () => {
		expect(sdkPackageName("api_resend")).toBe("@teamscala/api-resend");
		expect(sdkPackageName("api_namecheap")).toBe("@teamscala/api-namecheap");
		expect(sdkPackageName("api_jina")).toBe("@teamscala/api-jina");
	});

	test("non-api package: name maps straight through", () => {
		expect(sdkPackageName("aws")).toBe("@teamscala/aws");
		expect(sdkPackageName("cloudflare")).toBe("@teamscala/cloudflare");
	});

	test("explicit packageName wins when provided", () => {
		expect(sdkPackageName("api_resend", "@teamscala/resend")).toBe("@teamscala/resend");
	});

	test("empty explicit falls back to reconstruction", () => {
		expect(sdkPackageName("aws", "")).toBe("@teamscala/aws");
	});

	test("never double-prefixes api-* (the regression)", () => {
		expect(sdkPackageName("api_resend")).not.toBe("@teamscala/api-api_resend");
	});
});

describe("resolveSdkSecretOptions", () => {
	test("maps adapter fields to sealed secret row keys", async () => {
		const calls: Array<[string, string]> = [];
		const result = await resolveSdkSecretOptions(
			{
				apiKey: "zai-coding-plan-key",
				password: { slug: "vendor-login", key: "password" },
			},
			async (slug, key) => {
				calls.push([slug, key]);
				return `${slug}:${key}`;
			},
		);
		expect(result).toEqual({
			apiKey: "zai-coding-plan-key:token",
			password: "vendor-login:password",
		});
		expect(calls).toEqual([
			["zai-coding-plan-key", "token"],
			["vendor-login", "password"],
		]);
	});
});

describe("resolveSdkClientOptions", () => {
	const env = { JINA_API_KEY: "jina-secret", EMPTY: undefined };

	test("bakes baseUrl + resolves apiKey from env (the missing injection)", () => {
		expect(
			resolveSdkClientOptions(
				{ baseUrl: "https://s.jina.ai", apiKeyEnv: "JINA_API_KEY" },
				undefined,
				env,
			),
		).toEqual({ baseUrl: "https://s.jina.ai", apiKey: "jina-secret" });
	});

	test("caller args.client overrides the baked config", () => {
		expect(
			resolveSdkClientOptions(
				{ baseUrl: "https://s.jina.ai", apiKeyEnv: "JINA_API_KEY" },
				{ apiKey: "override" },
				env,
			),
		).toEqual({ baseUrl: "https://s.jina.ai", apiKey: "override" });
	});

	test("missing env var omits apiKey rather than passing undefined", () => {
		expect(
			resolveSdkClientOptions({ baseUrl: "https://x", apiKeyEnv: "EMPTY" }, undefined, env),
		).toEqual({ baseUrl: "https://x" });
	});

	test("no client config yields empty options (back-compat)", () => {
		expect(resolveSdkClientOptions(undefined, undefined, env)).toEqual({});
	});
});

describe("assertSdkAdapterResolvable — the boot gate", () => {
	test("an installed adapter resolves through its root export", () => {
		// @teamscala/os is installed in this package's node_modules with a
		// root "." export — the bare-name resolution the executor uses for
		// adapters that have one.
		expect(() => assertSdkAdapterResolvable("os")).not.toThrow();
	});

	test("a missing adapter refuses, naming the package and the sdk rows", () => {
		let message = "";
		try {
			assertSdkAdapterResolvable("api_does_not_exist");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("@teamscala/api-does-not-exist");
		expect(message).toContain("sdk:api_does_not_exist");
	});

	test("an entrySubpath-carrying adapter resolves through the subpath, not the root", () => {
		// Adapters without a root "." export (telegram, trackabi) resolve only
		// through their declared entrySubpath — the gate must use the same
		// entry path the executor uses, never the bare package name.
		expect(() =>
			assertSdkAdapterResolvable("os", undefined, "contracts/mcp"),
		).not.toThrow();
	});
});

describe("executeSdkTool require-failure surfaces the real error", () => {
	// THE 2026-08-26 INCIDENT: a WhatsApp send through the SDK executor returned
	// "SDK package @teamscala/api-gowa not installed" — but the actual cause was
	// MODULE_NOT_FOUND on a calling service whose node_modules lacks the
	// adapter. The catch at sdk.ts:51 swallowed the real error, so two
	// investigations went the wrong way. These tests assert the swallowed
	// message is gone — the real reason now reaches the caller, so the next
	// investigation sees MODULE_NOT_FOUND vs. SYNTAX vs. factory-missing without
	// the "not installed" misdirection.
	//
	// We mock `node:module`'s createRequire because the SDK executor uses
	// `createRequire(import.meta.url)(requirePath)` — a CommonJS-style require
	// that is NOT intercepted by `mock.module` (Bun's ESM mock).
	const baseTool = {
		id: "t",
		name: "api_does_not_exist_list",
		service: null,
		endpoint: null,
		http_method: null,
		orpc_procedure: null,
		executor_key: "sdk:api_does_not_exist",
		executor_config: {
			sdk: "api_does_not_exist",
			actionMap: {
				list: { method: "list", parameters: ["client", "params"] },
			},
		},
	};

	// Mocked createRequire: throws ONLY for the package name we expect to fail.
	// (mock.module is process-wide in Bun — a blanket-throw would leak into the
	// sibling recordOutboundMessagingSend test, which uses createRequire to
	// resolve @teamscala/api-gowa's listDevices for its bridge-device fallback.)
	let failingPath: string | null = null;
	mock.module("node:module", () => ({
		createRequire: (_url: string) => {
			return (id: string) => {
				if (failingPath && id === failingPath) {
					const err = new Error(
						`Cannot find module "${id}" Require stack: - scala-ai/src/index.ts`,
					) as Error & { code?: string };
					err.code = "MODULE_NOT_FOUND";
					throw err;
				}
				const stub = stubbedAdapterModules.get(id);
				if (stub) return stub;
				// For everything else, use the real loader so siblings aren't broken.
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				return require(id);
			};
		},
	}));
	afterEach(() => {
		failingPath = null;
		stubbedAdapterModules.clear();
	});

	function mockRequireThrows() {
		failingPath = "@teamscala/api-does-not-exist";
	}

	test("MODULE_NOT_FOUND from createRequire reaches the caller verbatim", async () => {
		mockRequireThrows();
		let caught: Error | null = null;
		try {
			await executeSdkTool(baseTool as never, { action: "list" }, {} as never);
		} catch (err) {
			caught = err as Error;
		}
		// The real Node MODULE_NOT_FOUND message (not the swallowed 'not installed').
		expect(caught?.message).toContain("Cannot find module");
		expect(caught?.message).toContain("@teamscala/api-does-not-exist");
		// And the explanatory copy pointing at the duplicate-vs-host split.
		expect(caught?.message).toContain("MODULE_NOT_FOUND");
	});

	test("never returns the pre-fix opaque 'not installed' when the real error names the package", async () => {
		mockRequireThrows();
		let caught: Error | null = null;
		try {
			await executeSdkTool(baseTool as never, { action: "list" }, {} as never);
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).not.toBeNull();
		// Pre-fix: "SDK package '@teamscala/api-does-not-exist' not installed. Install it."
		// Post-fix: includes the real error and points at the duplicate/calling-service split.
		expect(caught?.message).not.toMatch(
			/^SDK package ".*" not installed\. Install it\.$/,
		);
		expect(caught?.message).toMatch(/could not be required/);
	});
});

describe("executeSdkTool maps every declared parameter positionally", () => {
	// THE SECOND INCIDENT ON THIS LINE: the payload was read by ONE resolved
	// name (the first non-"client" declared parameter), so every
	// (client, params, body) operation — 319 across the generated adapters —
	// lost its body and reached the upstream API without it. The failure named
	// the supplier API ("Request body must be valid JSON"), never this
	// executor, so callers reshaped arguments forever and could not succeed.
	// These tests call a STUB adapter module (served through the mocked
	// createRequire above) and assert the arguments the operation received.
	const SDK = "api_stubarg";
	const PKG = "@teamscala/api-stubarg";

	function stubFactoryAdapter(calls: unknown[][]) {
		stubbedAdapterModules.set(PKG, {
			createStubargAdapter: (opts: Record<string, unknown>) => ({
				__client: true,
				opts,
			}),
			stubOp: async (...a: unknown[]) => {
				calls.push(a);
				return { ok: true };
			},
		});
	}

	function stubSelfContainedAdapter(calls: unknown[][]) {
		stubbedAdapterModules.set(PKG, {
			stubOp: async (...a: unknown[]) => {
				calls.push(a);
				return { ok: true };
			},
		});
	}

	function stubTool(parameters: string[] | undefined, dispatch?: string) {
		return {
			id: "t",
			name: "api_stubarg_tool",
			service: null,
			endpoint: null,
			http_method: null,
			orpc_procedure: null,
			executor_key: `sdk:${SDK}`,
			executor_config: {
				sdk: SDK,
				...(dispatch ? { dispatch } : {}),
				actionMap: {
					op: {
						method: "stubOp",
						...(parameters ? { parameters } : {}),
					},
				},
			},
		} as never;
	}

	afterEach(() => {
		stubbedAdapterModules.clear();
	});

	test("a (client, params, body) operation receives its body — the regression", async () => {
		const calls: unknown[][] = [];
		stubFactoryAdapter(calls);
		const body = { from: "a@b.c", to: ["x@y.z"], subject: "hi" };
		await executeSdkTool(
			stubTool(["client", "params", "body"]),
			{ action: "op", params: { "Idempotency-Key": "k1" }, body },
			{} as never,
		);
		expect(calls).toHaveLength(1);
		const [client, params, receivedBody] = calls[0];
		expect(client).toMatchObject({ __client: true });
		expect(params).toEqual({ "Idempotency-Key": "k1" });
		expect(receivedBody).toEqual(body);
	});

	test("a self-contained (token, body) operation receives both arguments", async () => {
		const calls: unknown[][] = [];
		stubSelfContainedAdapter(calls);
		await executeSdkTool(
			stubTool(["token", "body"], "self-contained"),
			{ action: "op", token: "re_123", body: { subject: "hi" } },
			{} as never,
		);
		expect(calls[0]).toEqual(["re_123", { subject: "hi" }]);
	});

	test("a (client, body) operation reads its payload by its declared name", async () => {
		const calls: unknown[][] = [];
		stubFactoryAdapter(calls);
		await executeSdkTool(
			stubTool(["client", "body"]),
			{ action: "op", body: { key: "val" } },
			{} as never,
		);
		expect(calls[0]).toHaveLength(2);
		expect(calls[0][1]).toEqual({ key: "val" });
	});

	test("legacy callers still send a single-payload operation under 'params'", async () => {
		const calls: unknown[][] = [];
		stubFactoryAdapter(calls);
		await executeSdkTool(
			stubTool(["client", "body"]),
			{ action: "op", params: { legacy: true } },
			{} as never,
		);
		expect(calls[0][1]).toEqual({ legacy: true });
	});

	test("an actionMap entry without declared parameters behaves as before", async () => {
		const calls: unknown[][] = [];
		stubFactoryAdapter(calls);
		await executeSdkTool(
			stubTool(undefined),
			{ action: "op", params: { a: 1 } },
			{} as never,
		);
		expect(calls[0]).toHaveLength(2);
		expect(calls[0][1]).toEqual({ a: 1 });
	});

	test("a client-only operation receives the client and nothing else", async () => {
		const calls: unknown[][] = [];
		stubFactoryAdapter(calls);
		await executeSdkTool(stubTool(["client"]), { action: "op" }, {} as never);
		expect(calls[0]).toHaveLength(1);
		expect(calls[0][0]).toMatchObject({ __client: true });
	});
});
