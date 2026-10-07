// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, mock, test } from "bun:test";
import { recordOutboundMessagingSend } from "./messaging-send-recorder.ts";
import { __resetFirstDeviceCacheForTests } from "./messaging-send-attribution.ts";

// THE INCIDENT FIXTURE MODULE GRAPH (2026-08-23): the production fallback path
// requires the adapter package through createRequire at call time. The real
// bridge reports the sending device as a JID; the binding row stores E.164.
// listDevices behavior is controllable per-test so the same graph exercises
// both the healthy bridge and the unreachable one.
let listDevicesBehavior: () => Promise<unknown> = async () => ({
	results: [{ jid: "447882532999@s.whatsapp.net", state: "logged_in" }],
});
mock.module("@teamscala/api-gowa", () => ({
	createGowaAdapter: () => ({ bridged: true }),
	listDevices: async () => listDevicesBehavior(),
}));
mock.module("@teamscala/db/registry/load-config", () => ({
	loadRegistryConfig: async () => ({
		gowa: { packageName: "@teamscala/api-gowa", initConfig: {} },
	}),
}));

function stubPrisma(opts: {
	existing?: { id: string; organisation_id: string | null } | null;
	noBots?: boolean;
}) {
	const createdConversations: unknown[] = [];
	const createdMessages: unknown[] = [];
	const updatedConversations: unknown[] = [];
	const createdLogs: unknown[] = [];
	const createdEvents: unknown[] = [];
	const prisma = {
		conversations: {
			findFirst: mock(async () => opts.existing ?? null),
			create: mock(async (input: { data: Record<string, unknown> }) => {
				createdConversations.push(input.data);
				return { id: "new-thread" };
			}),
			update: mock(async (input: unknown) => {
				updatedConversations.push(input);
				return {};
			}),
		},
		messages: {
			create: mock(async (input: { data: Record<string, unknown> }) => {
				createdMessages.push(input.data);
				return { id: "msg-1" };
			}),
		},
		messaging_logs: {
			create: mock(async (input: { data: Record<string, unknown> }) => {
				createdLogs.push(input.data);
				return { id: "log-1" };
			}),
		},
		messaging_bots: {
			findMany: mock(async () =>
				opts.noBots
					? []
					: [
							{ id: "b1", external_id: "+447882532999", ai_agent_id: "agent-pa", organisation_id: "org-1" },
						],
			),
		},
		event_log: {
			create: mock(async (input: { data: Record<string, unknown> }) => {
				createdEvents.push(input.data);
				return { id: "evt-1" };
			}),
		},
	};
	return { prisma, createdConversations, createdMessages, updatedConversations, createdLogs, createdEvents };
}

const TOOL_WITH_RECORD = {
	id: "t1",
	name: "api_gowa_message",
	executor_key: "sdk:api_gowa",
	service: null,
	endpoint: null,
	http_method: null,
	orpc_procedure: null,
	executor_config: { sdk: "api_gowa", messagingRecord: { channel: "whatsapp" } },
} as const;

describe("recordOutboundMessagingSend", () => {
	test("records an existing party send onto the existing thread, never creating a second one", async () => {
		const { prisma, createdConversations, createdMessages, updatedConversations, createdLogs } = stubPrisma({
			existing: { id: "thread-1", organisation_id: "org-1" },
		});
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "sendMessage", params: { phone: "61402349657", message: "thread continuity check" } },
			{ agentId: "agent-pa", organisationId: "org-1" },
			{ results: { message_id: "MSG1" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdConversations).toHaveLength(0);
		expect(createdMessages).toHaveLength(1);
		expect(createdMessages[0]).toMatchObject({
			channel: "ai",
			conversation_id: "thread-1",
			role: "assistant",
			direction: "outbound",
			content: "thread continuity check",
			external_id: "MSG1",
		});
		expect(updatedConversations).toHaveLength(1);
		// THE BUSINESS RECORD: the send lands in messaging_logs too — the log
		// that silently omitted tool sends was the fault of 2026-08-20.
		expect(createdLogs).toHaveLength(1);
		expect(createdLogs[0]).toMatchObject({
			organisation_id: "org-1",
			platform: "whatsapp",
			agent_id: "agent-pa",
			external_chat_id: "61402349657@s.whatsapp.net",
			user_phone: "61402349657@s.whatsapp.net",
			external_msg_id: "MSG1",
			direction: "outbound",
			event_type: "sent",
			content: "thread continuity check",
			payload: { send_kind: "tool", sent_via: "api_gowa_message" },
		});
	});

	test("creates the thread when the party has none, keyed like the inbound path", async () => {
		const { prisma, createdConversations, createdMessages } = stubPrisma({});
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "sendMessage", params: { phone: "+639054455160", message: "first outbound", device_id: "447882532999" } },
			{},
			{ results: { message_id: "MSG2" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdConversations).toHaveLength(1);
		expect(createdConversations[0]).toMatchObject({
			channel: "ai",
			user_id: "whatsapp:639054455160@s.whatsapp.net",
			channel_data: { assistant_type: "custom-gpt:agent-pa", source: "whatsapp" },
		});
		expect(createdMessages[0]).toMatchObject({
			conversation_id: "new-thread",
			external_id: "MSG2",
		});
	});

	test("does nothing for a tool that has not opted in, or a non-send action", async () => {
		const { prisma, createdMessages } = stubPrisma({});
		const noOptIn = { ...TOOL_WITH_RECORD, executor_config: { sdk: "api_gowa" } } as unknown as Parameters<typeof recordOutboundMessagingSend>[0];
		await recordOutboundMessagingSend(
			noOptIn,
			{ action: "sendMessage", params: { phone: "61402349657", message: "x" } },
			{},
			{},
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "listChats", params: {} },
			{},
			{},
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdMessages).toHaveLength(0);
	});

	test("a recording failure never throws into the tool result", async () => {
		const failing = {
			conversations: {
				findFirst: mock(async () => {
					throw new Error("db down");
				}),
			},
			messaging_bots: {
				findMany: mock(async () => [
					{ id: "b1", external_id: "+447882532999", ai_agent_id: "agent-pa", organisation_id: "org-1" },
				]),
			},
		} as unknown as Parameters<typeof recordOutboundMessagingSend>[4];
		await expect(
			recordOutboundMessagingSend(
				TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
				// An explicit device_id keeps this test off the live bridge device lookup.
				{ action: "sendMessage", params: { phone: "61402349657", message: "x", device_id: "447882532999" } },
				{ agentId: "a" },
				{},
				failing,
			),
		).resolves.toBeUndefined();
	});

	test("a send with no destination exits DURABLY — the no-destination exit writes the event_log row", async () => {
		const { prisma, createdEvents, createdMessages } = stubPrisma({});
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "sendMessage", params: { message: "goes nowhere attributable" } },
			{},
			{ results: { message_id: "MSG3" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdMessages).toHaveLength(0);
		expect(createdEvents).toHaveLength(1);
		// No facts were extractable (that IS the exit), so party/message_id are
		// null — the event still names the tool and the exit stage.
		expect(createdEvents[0]).toMatchObject({
			kind: "tool-executor.messaging-record.failed",
			payload_json: {
				tool: "api_gowa_message",
				party: null,
				message_id: null,
				stage: "no-destination",
			},
		});
	});

	test("an unattributable send exits DURABLY — the no-bot-binding exit writes the event_log row with the TRUE stage", async () => {
		// noBots: the sending device binds no agent, and the context carries no
		// agentId — the exact exit that was silent for the recorder's whole
		// deployed life (measured 2026-08-21: zero rows, zero events, zero logs).
		const { prisma, createdEvents, createdMessages } = stubPrisma({ noBots: true });
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			// Explicit device_id avoids the live bridge device lookup.
			{ action: "sendMessage", params: { phone: "61402349657", message: "x", device_id: "449999999999" } },
			{},
			{ results: { message_id: "MSG4" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdMessages).toHaveLength(0);
		expect(createdEvents).toHaveLength(1);
		expect(createdEvents[0]).toMatchObject({
			kind: "tool-executor.messaging-record.failed",
			payload_json: {
				tool: "api_gowa_message",
				party: "61402349657@s.whatsapp.net",
				stage: "no-bot-binding",
			},
		});
	});

	test("THE INCIDENT (2026-08-23): no device_id, no context agent — the production fallback still attributes via the bridge device, cross-spelling", async () => {
		// 14 live sends landed and none was attributed: the recorder reached
		// its sibling's client resolver by dynamic import, got `undefined` for
		// the unexported member, and a bare catch swallowed the TypeError.
		// This is the production wiring — nothing injected — so the regression
		// cannot hide behind a stubbed collaborator again.
		__resetFirstDeviceCacheForTests();
		const { prisma, createdMessages, createdEvents, createdLogs } = stubPrisma({});
		await recordOutboundMessagingSend(
			TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "sendMessage", params: { phone: "61428193498", message: "incident fixture" } },
			{},
			{ results: { message_id: "3EB0D8223663076CA61BC7" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
		);
		expect(createdEvents).toHaveLength(0);
		expect(createdMessages).toHaveLength(1);
		// The bridge device jid (447882532999@s.whatsapp.net) bound the row
		// stored as +447882532999 — same number, two spellings, one key.
		expect(createdMessages[0]).toMatchObject({
			channel: "ai",
			role: "assistant",
			direction: "outbound",
			external_id: "3EB0D8223663076CA61BC7",
		});
		expect(createdLogs).toHaveLength(1);
		expect(createdLogs[0]).toMatchObject({ agent_id: "agent-pa", direction: "outbound", event_type: "sent" });
	});

	test("an unreachable bridge exits DURABLY as device-unresolvable with the true cause — never as a missing-row claim", async () => {
		__resetFirstDeviceCacheForTests();
		const previous = listDevicesBehavior;
		listDevicesBehavior = async () => {
			throw new Error("bridge unreachable");
		};
		try {
			const { prisma, createdEvents, createdMessages } = stubPrisma({});
			await recordOutboundMessagingSend(
				TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
			{ action: "sendMessage", params: { phone: "61428193498", message: "x" } },
			{},
			{ results: { message_id: "MSG5" } },
			prisma as unknown as Parameters<typeof recordOutboundMessagingSend>[4],
			);
			expect(createdMessages).toHaveLength(0);
			expect(createdEvents).toHaveLength(1);
			expect(createdEvents[0]).toMatchObject({
				kind: "tool-executor.messaging-record.failed",
				payload_json: {
					stage: "device-unresolvable",
					error: "no phone-bearing device_id and the bridge device list resolved no logged-in device",
				},
			});
		} finally {
			listDevicesBehavior = previous;
		}
	});

	test("a thrown recording stage writes the event_log row via the same shared exit", async () => {
		const createdEvents: unknown[] = [];
		const prisma = {
			conversations: {
				findFirst: mock(async () => {
					throw new Error("db down");
				}),
			},
			messaging_bots: {
				findMany: mock(async () => [
					{ id: "b1", external_id: "+447882532999", ai_agent_id: "agent-pa", organisation_id: "org-1" },
				]),
			},
			event_log: {
				create: mock(async (input: { data: Record<string, unknown> }) => {
					createdEvents.push(input.data);
					return { id: "evt-1" };
				}),
			},
		} as unknown as Parameters<typeof recordOutboundMessagingSend>[4];
		await expect(
			recordOutboundMessagingSend(
				TOOL_WITH_RECORD as unknown as Parameters<typeof recordOutboundMessagingSend>[0],
				{ action: "sendMessage", params: { phone: "61402349657", message: "x", device_id: "447882532999" } },
				{ agentId: "a" },
				{},
				prisma,
			),
		).resolves.toBeUndefined();
		expect(createdEvents).toHaveLength(1);
		expect(createdEvents[0]).toMatchObject({
			kind: "tool-executor.messaging-record.failed",
			payload_json: { stage: "thread-find", error: "db down" },
		});
	});
});
