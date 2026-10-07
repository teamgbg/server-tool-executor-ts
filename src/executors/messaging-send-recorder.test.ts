// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, test } from "bun:test";
import {
	extractSendFacts,
	isSendAction,
	threadWhere,
} from "./messaging-send-recorder.ts";

describe("extractSendFacts", () => {
	test("normalises a bare E.164 phone into a whatsapp jid", () => {
		const facts = extractSendFacts(
			{ params: { phone: "+61402349657", message: "hello" } },
			{ results: { message_id: "3EB02EF2" } },
		);
		expect(facts).toEqual({
			partyJid: "61402349657@s.whatsapp.net",
			content: "hello",
			messageId: "3EB02EF2",
			deviceId: null,
		});
	});

	test("keeps a group jid and an explicit device id untouched", () => {
		const facts = extractSendFacts(
			{ params: { phone: "120363403423864514@g.us", message: "hi team", device_id: "447882532999@s.whatsapp.net" } },
			{ results: {} },
		);
		expect(facts?.partyJid).toBe("120363403423864514@g.us");
		expect(facts?.deviceId).toBe("447882532999@s.whatsapp.net");
		expect(facts?.messageId).toBeNull();
	});

	test("returns null when the send names no destination", () => {
		expect(extractSendFacts({ params: { message: "x" } }, {})).toBeNull();
	});

	test("reads the payload from body when params is absent", () => {
		const facts = extractSendFacts(
			{ body: { phone: "61402349657", text: "from body" } },
			undefined,
		);
		expect(facts?.content).toBe("from body");
	});
});

describe("isSendAction", () => {
	test("send* actions record; reads and management do not", () => {
		expect(isSendAction("sendMessage")).toBe(true);
		expect(isSendAction("sendImage")).toBe(true);
		expect(isSendAction("listChats")).toBe(false);
		expect(isSendAction("revokeMessage")).toBe(false);
	});
});

describe("threadWhere", () => {
	test("keys the thread exactly as the inbound receiver does", () => {
		expect(threadWhere("61402349657@s.whatsapp.net", "agent-1")).toEqual({
			channel: "ai",
			user_id: "whatsapp:61402349657@s.whatsapp.net",
			channel_data: { path: ["assistant_type"], equals: "custom-gpt:agent-1" },
		});
	});
});
