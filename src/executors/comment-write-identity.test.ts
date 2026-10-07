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
	applyDerivedCommentIdentity,
	deriveCommentIdentity,
} from "./comment-write-identity.ts";

const laneContext = {
	callerInfo: {
		tmuxTarget: "%270",
		label: "CLI Readiness — Class B…",
		orchestratorId: null,
		orchestratorSessionId: "019ffa44-1111-7111-8111-111111111111",
	},
	userId: "system",
} as const;

describe("comment write identity", () => {
	it("derives the active lane author and preserves the addressed recipient", async () => {
		const identity = await deriveCommentIdentity(
			{
				cli_sessions: {
					findFirst: async (args: unknown) => {
						return {
									id: "session-1",
									label: "CLI Readiness — Class B…",
									role: "worker",
								} as never;
					},
				},
				ai_agents: {
					findFirst: async () => null,
				},
			},
			laneContext,
		);
		const args: Record<string, unknown> = {
			data: {
				work_item_id: "forged-recipient",
				sender_name: "OPERATOR",
				sender_role: "operator",
				source_cli_session_id: "forged",
			},
		};

		applyDerivedCommentIdentity(args, identity);

		// sender_name is NULL whenever source_cli_session_id is set — the table's
		// `comments_session_sender_name_is_derived` check forbids both together.
		expect(args.data).toEqual({
			agent_id: null,
			sender_name: null,
			sender_role: "lane",
			source_cli_session_id: "session-1",
			work_item_id: "forged-recipient",
		});
	});

	it("derives a lane only from its durable CLI session identity", async () => {
		let received: unknown;
		const identity = await deriveCommentIdentity(
			{
				cli_sessions: {
					findFirst: async (args: unknown) => {
						received = args;
						return {
							id: "session-codex",
							label: "Unify CLI ingestion",
							role: "worker",
						};
					},
				},
				ai_agents: { findFirst: async () => null },
			},
			{
				userId: "system",
				callerInfo: {
					orchestratorSessionId: "019ffa44-2222-7222-8222-222222222222",
					orchestratorId: "tmux:%270",
					tmuxTarget: "%999",
					tmuxSession: null,
					label: "Duplicated Orchestrator",
				},
			},
		);

		expect(identity).toEqual({
			agent_id: null,
			source_cli_session_id: "session-codex",
			sender_name: null,
			sender_role: "lane",
		});
		expect(received).toEqual({
			where: {
				closed_at: null,
				id: "019ffa44-2222-7222-8222-222222222222",
			},
			select: {
				id: true,
				label: true,
				role: true,
			},
		});
	});

	it("refuses pane and label fallbacks when the durable session id is absent", async () => {
		let queried = false;
		await expect(
			deriveCommentIdentity(
				{
					cli_sessions: {
						findFirst: async () => {
							queried = true;
							return {
								id: "wrong-session",
								label: "Duplicated Orchestrator",
								role: "orchestrator",
							};
						},
					},
					ai_agents: { findFirst: async () => null },
				},
				{
					userId: "system",
					callerInfo: {
						orchestratorSessionId: null,
						orchestratorId: "tmux:%270",
						tmuxTarget: "%270",
						tmuxSession: null,
						label: "Duplicated Orchestrator",
					},
				},
			),
		).rejects.toThrow("caller identity could not be resolved");
		expect(queried).toBe(false);
	});

	it("rejects an unresolved system writer", async () => {
		await expect(
			deriveCommentIdentity(
				{
					cli_sessions: { findFirst: async () => null },
					ai_agents: { findFirst: async () => null },
				},
				laneContext,
			),
		).rejects.toThrow("caller identity could not be resolved");
	});

	it("derives an agent foreign key and ignores caller-supplied author fields", async () => {
		let received: unknown;
		const identity = await deriveCommentIdentity(
			{
				cli_sessions: { findFirst: async () => null },
				ai_agents: {
					findFirst: async (args: unknown) => {
						received = args;
						return { id: "agent-1", name: "Fleet Watchdog" };
					},
				},
			},
			{ ...laneContext, agentId: "fleet-watchdog" },
		);
		expect(identity).toEqual({
			agent_id: "agent-1",
			source_cli_session_id: null,
			sender_name: "Fleet Watchdog",
			sender_role: "system",
		});
		expect(received).toEqual({
			where: { OR: [{ id: "fleet-watchdog" }, { slug: "fleet-watchdog" }] },
			select: { id: true, name: true },
		});
	});

	// A WRONG-SHAPED CLIENT MUST NAME ITSELF, NOT ACCUSE THE AGENT.
	//
	// `prisma` is typed `unknown` and cast to SessionLookup, so the compiler
	// cannot catch a caller passing the wrong thing. The read used to be
	// `delegate.ai_agents?.findFirst(...)`, and that optional chain spent the
	// only remaining chance to notice: hand it a raw pooled connection and the
	// chain yields undefined, `!agent` holds, and the caller is told
	// `caller agent <id> does not exist` — a confident, specific, FALSE claim
	// about data, pointing every reader at the wrong subject.
	//
	// Found 2026-09-06 while diagnosing bounded-comment-effect's Prisma 8
	// failure: the obvious port of that caller passes a pooled transaction
	// here, and would have converted a loud `Object is not a function` into a
	// quiet lie about an agent that exists perfectly well.
	it("refuses a client with no ai_agents model instead of reporting a missing agent", async () => {
		const rawPooledConnection = { query: async () => ({ rows: [], rowCount: 0 }) };
		let thrown: unknown;
		try {
			await deriveCommentIdentity(rawPooledConnection, {
				...laneContext,
				agentId: "fleet-watchdog",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TypeError);
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		// It must blame the CLIENT and say what it got...
		expect(message).toContain("exposes no ai_agents.findFirst");
		expect(message).toContain("query");
		// ...and must NOT make a claim about whether the agent exists.
		expect(message).not.toContain("does not exist");
	});

	// THE DATABASE CHECK, ASSERTED IN THE SUITE. comments carries
	// `comments_session_sender_name_is_derived`:
	//   CHECK (source_cli_session_id IS NULL OR sender_name IS NULL)
	// Every branch above returns one identity shape, and none of them may set
	// both fields. This test is written over ALL branches rather than one, so a
	// future branch inherits it automatically.
	//
	// It exists because the two-field write was shipped, was covered by passing
	// tests, and still took fleet commenting down for over an hour on
	// 2026-08-13 — the unit tests never touched Postgres, so the check that
	// would have rejected it was the one thing the suite could not see. A test
	// asserting the current return value is a snapshot of an assumption; this
	// one asserts the invariant the database will enforce regardless.
	it("never returns both a session id and a sender name (the DB check)", async () => {
		const branches = [
			// agent branch
			await deriveCommentIdentity(
				{
					cli_sessions: { findFirst: async () => null },
					ai_agents: { findFirst: async () => ({ id: "agent-1", name: "Fleet Watchdog" }) },
				},
				{ ...laneContext, agentId: "fleet-watchdog" },
			),
			// session branch
			await deriveCommentIdentity(
				{
					cli_sessions: {
						findFirst: async () => ({ id: "session-1", label: "Some Lane", role: "worker" }),
					},
					ai_agents: { findFirst: async () => null },
				},
				laneContext,
			),
			// operator branch
			await deriveCommentIdentity(
				{
					cli_sessions: { findFirst: async () => null },
					ai_agents: { findFirst: async () => null },
				},
				{ userId: "13ba2c3f-027e-49bd-af1d-85666cb1feba", callerInfo: {} },
			),
		];

		for (const identity of branches) {
			const violatesCheck =
				identity.source_cli_session_id !== null && identity.sender_name !== null;
			expect(violatesCheck).toBe(false);
		}
	});
});
