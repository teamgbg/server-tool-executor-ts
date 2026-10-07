// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, mock, test } from "bun:test";
import {
	phoneDigitsOf,
	resolveFirstDeviceDigits,
	resolveSendingAgentId,
	__resetFirstDeviceCacheForTests,
} from "./messaging-send-attribution.ts";

describe("phoneDigitsOf — one comparison key for every legitimate spelling", () => {
	test("reduces E.164, bare digits, and a whatsapp jid to the same key", () => {
		expect(phoneDigitsOf("+447882532999")).toBe("447882532999");
		expect(phoneDigitsOf("447882532999")).toBe("447882532999");
		expect(phoneDigitsOf("447882532999@s.whatsapp.net")).toBe("447882532999");
		expect(phoneDigitsOf("+44 7882 532999")).toBe("447882532999");
		expect(phoneDigitsOf("(+44) 7882-532999")).toBe("447882532999");
	});

	test("rejects non-phone spellings instead of manufacturing garbage digits", () => {
		// THE SECOND SEAM OF THE 2026-08-23 CLASS: a bridge device UUID or a
		// display name is not a phone number; stripping its non-digits would
		// shadow the working bridge-device fallback with garbage.
		expect(phoneDigitsOf("d42efd66-c948-4c4c-98eb-b0877dc77af6")).toBeNull();
		expect(phoneDigitsOf("scala PA")).toBeNull();
		expect(phoneDigitsOf("123456")).toBeNull();
		expect(phoneDigitsOf("")).toBeNull();
		expect(phoneDigitsOf(null)).toBeNull();
		expect(phoneDigitsOf(undefined)).toBeNull();
	});
});

function stubBots(bots: Array<{ id: string; external_id: string | null; ai_agent_id: string | null; organisation_id: string | null }>) {
	return {
		messaging_bots: { findMany: mock(async () => bots) },
	} as unknown as Parameters<typeof resolveSendingAgentId>[0];
}

describe("resolveFirstDeviceDigits", () => {
	test("resolves the first logged-in device via the DEVICE list (listDevices), never the app-session endpoint", async () => {
		// Locks the measured 2026-08-21 defect: the recorder called
		// appDevices (GET /app/devices), which fails on this bridge — every
		// un-device_id'd send exited unattributed. The device-session list
		// (listDevices → GET /devices) is the operation that verifiably
		// works from the gateway dispatch surface.
		const mod = {
			createGowaAdapter: () => ({}),
			listDevices: async () => ({
				results: [
					{ jid: "614000000000@s.whatsapp.net", state: "disconnected" },
					{ jid: "447882532999@s.whatsapp.net", state: "logged_in" },
				],
			}),
			appDevices: async () => {
				throw new Error("app-session endpoint must not be used");
			},
		};
		const digits = await resolveFirstDeviceDigits(
			"@teamscala/api-gowa",
			async () => ({}),
			() => mod as unknown as Record<string, unknown>,
		);
		expect(digits).toBe("447882532999");
	});

	test("a failing client-options loader surfaces the cause, returns null — never a silent swallow", async () => {
		// THE 2026-08-23 INCIDENT: the production loadClientOpts threw (the
		// recorder's dynamic import of its sibling yielded undefined) and a
		// bare catch ate it. The exit is still fail-open (the message already
		// left) but the cause must be observable.
		const errors: string[] = [];
		const { getLogger } = await import("../configure.ts");
		const originalError = getLogger().error;
		getLogger().error = ((msg: string) => {
			errors.push(String(msg));
		}) as typeof originalError;
		try {
			__resetFirstDeviceCacheForTests();
			const digits = await resolveFirstDeviceDigits(
				"@teamscala/api-gowa",
				async () => {
					throw new TypeError("resolveAdapterClientOptions is not a function");
				},
				() => ({ createGowaAdapter: () => ({}), listDevices: async () => ({ results: [] }) }) as unknown as Record<string, unknown>,
			);
			expect(digits).toBeNull();
			expect(errors.some((line) => line.includes("listDevices call failed") && line.includes("not a function"))).toBe(true);
		} finally {
			getLogger().error = originalError;
		}
	});
});

describe("resolveSendingAgentId — distinct failure stages, never a conflated cause", () => {
	const bots = [
		{ id: "bot-1", external_id: "+447446126888", ai_agent_id: "agent-a", organisation_id: "org-1" },
		{ id: "bot-2", external_id: "+447882532999", ai_agent_id: "agent-pa", organisation_id: "org-1" },
	];

	test("the chat-turn context agent wins", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{ agentId: "turn-agent", organisationId: "org-9" },
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: null },
			"447446126888",
		);
		expect(resolved).toEqual({ ok: true, agentId: "turn-agent", organisationId: "org-9" });
	});

	test("a CLI call attributes to the bridge's first device, never an arbitrary bot row", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: null },
			"447882532999",
		);
		expect(resolved).toEqual({ ok: true, agentId: "agent-pa", organisationId: "org-1" });
	});

	test("CROSS-SPELLING BIND (the incident's demanded fixture): a device identity in one spelling binds a messaging_bots row in the other", async () => {
		// The bridge reports the device as a jid; the row stores E.164. These
		// are the same number and MUST bind.
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: "447882532999@s.whatsapp.net" },
			null,
		);
		expect(resolved).toEqual({ ok: true, agentId: "agent-pa", organisationId: "org-1" });
	});

	test("a non-phone device_id (bridge UUID) is ignored, not turned into garbage digits", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: "d42efd66-c948-4c4c-98eb-b0877dc77af6" },
			null,
		);
		expect(resolved).toEqual({
			ok: false,
			stage: "device-unresolvable",
			cause: "no phone-bearing device_id and the bridge device list resolved no logged-in device",
		});
	});

	test("with nothing resolvable the exit is device-unresolvable (infra), not a missing-row claim", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: null },
			null,
		);
		expect(resolved).toMatchObject({ ok: false, stage: "device-unresolvable" });
	});

	test("a resolvable device that binds no row is no-bot-binding (data), with the digits named", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots(bots),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: null },
			"449999999999",
		);
		expect(resolved).toEqual({
			ok: false,
			stage: "no-bot-binding",
			cause: "no active messaging_bots row binds the sending device 449999999999",
		});
	});

	test("an active bot with no agent is bot-without-agent, naming the row", async () => {
		const resolved = await resolveSendingAgentId(
			stubBots([
				{ id: "bot-bare", external_id: "+447882532999", ai_agent_id: null, organisation_id: "org-1" },
			]),
			{},
			{ partyJid: "x@s.whatsapp.net", content: "", messageId: null, deviceId: null },
			"447882532999",
		);
		expect(resolved).toEqual({
			ok: false,
			stage: "bot-without-agent",
			cause: 'bot bot-bare (+447882532999) is active but carries no ai_agent_id',
		});
	});
});
