/**
 * @system tool-executor
 * @status handwritten
 */

import { getLogger, type InjectedServerClient } from "../configure.ts";
import type { ExecutionContext } from "../lib/types";

const logger = getLogger();

export interface SendFacts {
	/** The party the message went to, as a WhatsApp jid (<digits>@s.whatsapp.net or <id>@g.us). */
	partyJid: string;
	content: string;
	/** The id WhatsApp assigned, when the adapter returned one. */
	messageId: string | null;
	/** The device that sent, when the caller named one. */
	deviceId: string | null;
}

/**
 * The digits of a PHONE-BEARING spelling, or null when the value is not one.
 * The same device identity legitimately exists in several spellings (+E.164,
 * bare digits, <digits>@s.whatsapp.net) — they all reduce to one digit string
 * HERE, the single comparison key. A spelling that carries letters (a bridge
 * device UUID like "d42efd66-…", a display name) is NOT a phone number:
 * stripping its non-digits would manufacture a garbage key that silently
 * shadows the working bridge-device fallback (the second seam of the
 * 2026-08-23 incident class).
 */
export function phoneDigitsOf(value: string | null | undefined): string | null {
	if (!value) return null;
	const local = (value.split("@")[0] ?? value).trim();
	if (!/^[(+\d][\d\s().+-]*$/.test(local)) return null;
	const digits = local.replace(/\D/g, "");
	return digits.length >= 7 ? digits : null;
}

// The GOWA bridge's first logged-in device, cached (the device set changes on
// human timescales — `hot-path-resolutions-are-cached`). This is the device a
// send without an explicit device_id physically goes out on, so it is the
// identity the thread must be attributed to — taking an arbitrary bot row
// instead would record the send on the wrong agent's thread.
let _firstDeviceCache: { digits: string; expiresAt: number } | null = null;

/**
 * Every failure exit is LOUD (fail-open-noisy — the message already left, so
 * the send result must not fail, but the cause is always logged). This
 * resolver once returned null through a bare catch and every tool-path send
 * exited unattributed for days (2026-08-23).
 */
export async function resolveFirstDeviceDigits(
	packageName: string,
	loadClientOpts: () => Promise<Record<string, unknown>>,
	requireFn: (name: string) => Record<string, unknown>,
): Promise<string | null> {
	const now = Date.now();
	if (_firstDeviceCache && now < _firstDeviceCache.expiresAt) {
		return _firstDeviceCache.digits;
	}
	const fail = (cause: string): null => {
		logger.error?.(`[messaging-record] sending-device resolution failed: ${cause}`);
		return null;
	};
	const msg = (error: unknown) => (error instanceof Error ? error.message : String(error));
	let mod: Record<string, unknown>;
	try {
		mod = requireFn(packageName);
	} catch (error) {
		return fail(`adapter package ${packageName} not loadable (${msg(error)})`);
	}
	const factoryName = Object.keys(mod).find((k) => k.startsWith("create") && k.endsWith("Adapter"));
	if (!factoryName) return fail(`adapter ${packageName} exports no create*Adapter factory`);
	const factory = mod[factoryName] as (opts: Record<string, unknown>) => unknown;
	// THE DEVICE-SESSION LIST (`listDevices` → GET /devices), never the
	// app-session endpoint (`appDevices` → GET /app/devices): measured
	// live 2026-08-21, the recorder called appDevices, which fails on
	// this bridge, so EVERY un-device_id'd send exited unattributed.
	// listDevices is the same operation the api_gowa_devices tool serves
	// — verified working from this exact dispatch surface.
	const listDevices = mod.listDevices as ((client: unknown) => Promise<unknown>) | undefined;
	if (typeof listDevices !== "function") {
		return fail(`adapter ${packageName} exports no listDevices`);
	}
	let res:
		| { results?: Array<{ device?: unknown; jid?: unknown; state?: unknown }> }
		| undefined;
	try {
		res = (await listDevices(factory(await loadClientOpts()))) as typeof res;
	} catch (error) {
		return fail(`listDevices call failed (${msg(error)})`);
	}
	// Only a logged_in device can be the physical sender of a send
	// without an explicit device_id — never attribute to a disconnected one.
	const entry = res?.results?.find(
		(d) => d.state === undefined || d.state === "logged_in" || d.state === "connected",
	);
	if (!entry) return fail("the bridge reports no logged-in device");
	const raw =
		(typeof entry.jid === "string" && entry.jid) ||
		(typeof entry.device === "string" && entry.device) ||
		"";
	const digits = phoneDigitsOf(raw);
	if (!digits) return fail(`device entry carries no phone-bearing identity (jid=${JSON.stringify(entry.jid)})`);
	_firstDeviceCache = { digits, expiresAt: now + 30 * 60_000 };
	return digits;
}

/** Test-only: the bridge-device cache is module state; tests reset it between scenarios. */
export function __resetFirstDeviceCacheForTests(): void {
	_firstDeviceCache = null;
}

/** What `resolveSendingAgentId` decided, with the exit that decided it. */
export type SendingAgentResolution =
	| { ok: true; agentId: string; organisationId: string | null }
	| {
			ok: false;
			stage: "device-unresolvable" | "no-bot-binding" | "bot-without-agent";
			cause: string;
	  };

/**
 * The agent whose thread this send belongs to. In a chat turn the context
 * carries the running agent; a CLI call resolves the sender from the binding
 * rows instead: a phone-bearing device_id names its bot, otherwise the
 * bridge's first logged-in device is the sender and its agent owns the
 * thread — the same default an unrecognized inbound sender would get.
 *
 * Failure stages are DISTINCT (2026-08-23: every exit was filed as one
 * message, hiding an infra failure behind a missing-row claim).
 */
export async function resolveSendingAgentId(
	client: InjectedServerClient,
	context: ExecutionContext,
	facts: SendFacts,
	firstDeviceDigits: string | null,
): Promise<SendingAgentResolution> {
	if (context.agentId) {
		return { ok: true, agentId: context.agentId, organisationId: context.organisationId ?? null };
	}
	const explicitDigits = phoneDigitsOf(facts.deviceId);
	if (facts.deviceId && !explicitDigits) {
		logger.error?.(
			`[messaging-record] device_id ${JSON.stringify(facts.deviceId)} is not a phone spelling (UUID or name?) — ignored, falling back to the bridge device list`,
		);
	}
	const senderDigits = explicitDigits ?? firstDeviceDigits;
	if (!senderDigits) {
		return {
			ok: false,
			stage: "device-unresolvable",
			cause: "no phone-bearing device_id and the bridge device list resolved no logged-in device",
		};
	}
	// No `take` cap: a cap here would silently exclude the binding row once
	// the platform grows past it — the match must see every active row.
	const bots = (await client.messaging_bots.findMany({
		where: { platform: "whatsapp", is_active: true },
	})) as Array<{
		id: string;
		external_id: string | null;
		ai_agent_id: string | null;
		organisation_id: string | null;
	}>;
	const bot = bots.find((candidate) => phoneDigitsOf(candidate.external_id) === senderDigits);
	if (!bot) {
		return {
			ok: false,
			stage: "no-bot-binding",
			cause: `no active messaging_bots row binds the sending device ${senderDigits}`,
		};
	}
	if (!bot.ai_agent_id) {
		return {
			ok: false,
			stage: "bot-without-agent",
			cause: `bot ${bot.id} (${bot.external_id ?? "no external_id"}) is active but carries no ai_agent_id`,
		};
	}
	return { ok: true, agentId: bot.ai_agent_id, organisationId: bot.organisation_id };
}
