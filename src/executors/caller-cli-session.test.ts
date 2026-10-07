// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { describe, expect, it } from "bun:test";
import {
	findOpenCliSessionById,
	resolveCallerCliSession,
} from "./caller-cli-session.ts";

const openSession = {
	id: "019ffa44-1111-7111-8111-111111111111",
	label: "A lane can write a peer task",
	role: "worker",
};

const prismaWith = (row: unknown) => ({
	cli_sessions: {
		findFirst: async (args: unknown) => {
			const { where } = args as { where: { id: string; closed_at: null } };
			if (where.id === openSession.id && where.closed_at === null) {
				return row as never;
			}
			return null;
		},
	},
});

describe("findOpenCliSessionById", () => {
	it("returns the open session for a UUID naming one", async () => {
		const session = await findOpenCliSessionById(
			prismaWith(openSession),
			openSession.id,
		);
		expect(session).toEqual(openSession);
	});

	it("resolves nothing for a non-UUID candidate (unexpanded template, pane, label)", async () => {
		const prisma = prismaWith(openSession);
		expect(await findOpenCliSessionById(prisma, "${SCALA_FLEET_CLI_SESSION_ID}")).toBeNull();
		expect(await findOpenCliSessionById(prisma, "%1126")).toBeNull();
		expect(await findOpenCliSessionById(prisma, "")).toBeNull();
		expect(await findOpenCliSessionById(prisma, null)).toBeNull();
		expect(await findOpenCliSessionById(prisma, undefined)).toBeNull();
	});

	it("resolves nothing for an id from another namespace (dashboard UUID: closed row)", async () => {
		const prisma = {
			cli_sessions: {
				findFirst: async () => null,
			},
		};
		expect(
			await findOpenCliSessionById(
				prisma,
				"019ffc05-2222-7222-8222-222222222222",
			),
		).toBeNull();
	});
});

describe("resolveCallerCliSession", () => {
	it("resolves the caller from the session-id candidate the request context carries", async () => {
		const session = await resolveCallerCliSession(prismaWith(openSession), {
			callerInfo: { orchestratorSessionId: openSession.id },
		});
		expect(session).toEqual(openSession);
	});

	it("is null when the context carries no session candidate", async () => {
		const session = await resolveCallerCliSession(prismaWith(openSession), {
			callerInfo: { tmuxTarget: "%1126" },
		});
		expect(session).toBeNull();
	});
});
