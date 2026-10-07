/**
 * @system tool-executor
 * @status handwritten
 */

import { createRequire } from "node:module";
import { getLogger, getServerClient } from "@teamscala/tool-executor-substrate/configure.ts";
import type { InjectedServerClient } from "@teamscala/tool-executor-substrate/configure.ts";
import type { ExecutionContext, ToolDefinition } from "@teamscala/tool-executor-substrate/lib/types.ts";
import {
	resolveAdapterClientOptions,
	sdkPackageName,
} from "./sdk-client-options.ts";
import {
	type SendFacts,
	resolveFirstDeviceDigits,
	resolveSendingAgentId,
} from "./messaging-send-attribution.ts";

const logger = getLogger();

export interface MessagingRecordConfig {
	channel: "whatsapp";
}

export type { SendFacts } from "./messaging-send-attribution.ts";

export function extractSendFacts(
	args: Record<string, unknown>,
	result: unknown,
): SendFacts | null {
	const params = (args.params ?? args.body ?? {}) as Record<string, unknown>;
	const phone = typeof params.phone === "string" ? params.phone.trim() : "";
	const chatJid = typeof params.chat_jid === "string" ? params.chat_jid.trim() : "";
	const rawTo = phone || chatJid;
	if (!rawTo) return null;
	const content =
		(typeof params.message === "string" && params.message) ||
		(typeof params.text === "string" && params.text) ||
		(typeof params.caption === "string" && params.caption) ||
		"";
	const partyJid = rawTo.includes("@")
		? rawTo
		: `${rawTo.replace(/\D/g, "")}@s.whatsapp.net`;
	const r = result as { results?: { message_id?: unknown; id?: unknown } } | undefined;
	const rawId = r?.results?.message_id ?? r?.results?.id;
	const messageId = typeof rawId === "string" && rawId ? rawId : null;
	const deviceId = typeof params.device_id === "string" ? params.device_id : null;
	return { partyJid, content, messageId, deviceId };
}

export function isSendAction(action: string): boolean {
	return action.startsWith("send");
}

export function threadWhere(partyJid: string, agentId: string) {
	return {
		channel: "ai" as const,
		user_id: `whatsapp:${partyJid}`,
		channel_data: { path: ["assistant_type"], equals: `custom-gpt:${agentId}` },
	};
}

export async function writeUnrecordedSendEvent(
	serverClientOverride: InjectedServerClient | undefined,
	tool: ToolDefinition,
	partyJid: string | null,
	messageId: string | null,
	stage: string,
	error: string,
): Promise<void> {
	try {
		const client = serverClientOverride ?? getServerClient();
		await client.event_log?.create?.({
			data: {
				kind: "tool-executor.messaging-record.failed",
				payload_json: {
					tool: tool.name,
					party: partyJid,
					message_id: messageId,
					stage,
					error,
				},
			},
		});
	} catch {
		// The recording failed AND the durable failure record failed — the
		// logger line at the call site is the only trace. Nothing further to
		// do here: rethrowing would fail a send that already succeeded.
	}
}

export async function recordOutboundMessagingSend(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ExecutionContext,
	result: unknown,
	serverClientOverride?: InjectedServerClient,
): Promise<void> {
	const config = (tool.executor_config ?? {}) as {
		messagingRecord?: MessagingRecordConfig;
	};
	if (!config.messagingRecord) return;
	const action = String(args.action ?? "");
	if (!isSendAction(action)) return;

	const facts = extractSendFacts(args, result);
	if (!facts) {
		logger.warn?.(
			`[messaging-record] ${tool.name} send carried no destination — nothing recorded`,
		);
		// DURABLE, not just traced: the send left with no recordable
		// destination — an exit that does not record must be observable.
		await writeUnrecordedSendEvent(
			serverClientOverride,
			tool,
			null,
			null,
			"no-destination",
			"send args carried no phone/chat_jid — nothing to attribute the outbound to",
		);
		return;
	}

	let stage = "boot";
	try {
		const client = serverClientOverride ?? getServerClient();

		// Resolve the physical sender: an explicit phone-bearing device_id
		// wins, else the bridge's first logged-in device (cached). Without
		// either, refuse to attribute rather than record on a guessed thread.
		let firstDeviceDigits: string | null = null;
		if (!facts.deviceId) {
			stage = "device-resolution";
			const packageName = sdkPackageName(
				String(tool.executor_config?.sdk ?? ""),
				tool.executor_config?.packageName as string | undefined,
			);
			firstDeviceDigits = await resolveFirstDeviceDigits(
				packageName,
				() => resolveAdapterClientOptions(packageName, args.client as Record<string, unknown> | undefined),
				(name) => createRequire(import.meta.url)(name) as Record<string, unknown>,
			);
		}

		stage = "agent-resolution";
		const sender = await resolveSendingAgentId(client, context, facts, firstDeviceDigits);
		if (!sender.ok) {
			logger.error?.(
				`[messaging-record] ${sender.stage}: ${sender.cause} — outbound to ${facts.partyJid} NOT attributed`,
			);
			// DURABLE, not just traced: the stage and cause name the TRUE
			// exit (the 2026-08-23 incident hid a TypeError behind a
			// data-gap message for 14 sends).
			await writeUnrecordedSendEvent(
				serverClientOverride,
				tool,
				facts.partyJid,
				facts.messageId,
				sender.stage,
				sender.cause,
			);
			return;
		}
		const { agentId, organisationId } = sender;
		const assistantType = `custom-gpt:${agentId}`;

		stage = "thread-find";
		const existing = (await client.conversations.findFirst({
			where: threadWhere(facts.partyJid, agentId),
			select: { id: true, organisation_id: true },
		})) as { id: string; organisation_id: string | null } | null;

		stage = "thread-create";
		const conversationId =
			existing?.id ??
			(await client.conversations.create({
				data: {
					id: crypto.randomUUID(),
					channel: "ai",
					user_id: `whatsapp:${facts.partyJid}`,
					organisation_id: organisationId,
					title: facts.partyJid,
					status: "active",
					external_id: facts.partyJid,
					channel_data: {
						assistant_type: assistantType,
						source: "whatsapp",
						contact_phone: facts.partyJid.split("@")[0] ?? null,
					},
				},
				select: { id: true },
			})).id;

		stage = "message-write";
		await client.messages.create({
			data: {
				channel: "ai",
				conversation_id: conversationId,
				organisation_id: existing?.organisation_id ?? organisationId,
				role: "assistant",
				direction: "outbound",
				content: facts.content || null,
				external_id: facts.messageId,
				channel_data: {
					from: facts.deviceId,
					is_from_me: true,
					sent_via: tool.name,
				},
				occurred_at: new Date(),
			},
		});
		stage = "timestamp-update";
		await client.conversations.update({
			where: { id: conversationId },
			data: { last_message_at: new Date() },
		});

		// The messaging-service log is the durable business record of every
		// send, whatever adapter it went through (orchestrator ruling
		// 2026-08-20: a log that silently omits sends is worse than no log).
		// The Rust service's own send path writes this table at its chokepoint
		// (`message_log::write_outbound_tracked`); THIS is the tool-dispatch
		// chokepoint, so the same record lands here — same direction vocabulary
		// ('outbound'), same event_type ('sent'), the provider id included.
		stage = "messaging-log-write";
		await client.messaging_logs.create({
			data: {
				id: crypto.randomUUID(),
				organisation_id: organisationId ?? "",
				platform: "whatsapp",
				agent_id: agentId,
				external_chat_id: facts.partyJid,
				// The recipient, same spelling the inbound writer uses for the
				// sender (the full jid) — a log that cannot name WHO a message
				// went to cannot answer its own first question (measured
				// 2026-08-26: every outbound row had user_phone NULL).
				user_phone: facts.partyJid,
				external_msg_id: facts.messageId,
				direction: "outbound",
				event_type: "sent",
				content: facts.content || null,
				payload: { send_kind: "tool", sent_via: tool.name },
			},
		});
		logger.info?.(
			`[messaging-record] outbound to ${facts.partyJid} recorded on thread ${conversationId}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error?.(
			`[messaging-record] FAILED to record ${tool.name} send to ${facts.partyJid}: ${message}`,
		);
		// DURABLE, not just traced — the one shared exit every unrecorded
		// send uses: same kind, same shape.
		await writeUnrecordedSendEvent(serverClientOverride, tool, facts.partyJid, facts.messageId, stage, message);
	}
}
