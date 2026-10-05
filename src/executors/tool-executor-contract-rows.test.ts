/**
 * @status generated — ts_function_contract_runner template (scala-test-suites
 * templates/ts_function_contract_runner.pkl @1.4.0) over @teamscala/tool-executor's
 * test_vector rows: one `it` per function_call row (args -> value or
 * expect_error) and one per fs_flow row (ordered steps in a temp
 * workspace). This runner carries NO facts: every case is the registry
 * row projected into ./tool-executor-contract-rows.json. Regenerate from
 * inputs/<repo>/function_contract_runner.json; hand edits are overwritten.
 */
// A RECURSIVE-DESCENT EVALUATOR over arithmetic only. It is a parser
// rather than new Function(...) on purpose: a row's formula is DATA
// projected out of the database, and evaluating data as code would let
// a row execute anything the runner can reach. The grammar is four
// levels — expression, term, factor, primary — over numbers, the
// binary operators + - * /, parentheses, unary minus, the two helper
// calls round(x, n) and abs(x), and @name meaning "this member of the
// value the call returned". Nothing else parses, so nothing else can
// run.
function arithmetic(source: string, value: unknown, slug: string): number {
	let pos = 0;
	const text = source;
	const fail = (why: string): never => { throw new Error("row " + slug + " is malformed: member_equals_expression " + JSON.stringify(source) + " — " + why); };
	const skip = (): void => { while (pos < text.length && text[pos] === " ") pos++; };
	const eat = (ch: string): void => { skip(); if (text[pos] !== ch) fail("expected " + JSON.stringify(ch) + " at offset " + pos); pos++; };
	const number = (): number => {
		skip();
		const start = pos;
		while (pos < text.length && /[0-9.]/.test(text[pos])) pos++;
		if (start === pos) fail("expected a number at offset " + start);
		const got = Number(text.slice(start, pos));
		if (Number.isNaN(got)) fail(JSON.stringify(text.slice(start, pos)) + " is not a number");
		return got;
	};
	const identifier = (): string => {
		skip();
		const start = pos;
		while (pos < text.length && /[A-Za-z0-9_@.]/.test(text[pos])) pos++;
		if (start === pos) fail("expected a name at offset " + start);
		return text.slice(start, pos);
	};
	const primary = (): number => {
		skip();
		if (text[pos] === "(") { pos++; const inner = expression(); eat(")"); return inner; }
		if (text[pos] === "-") { pos++; return -primary(); }
		if (text[pos] === "+") { pos++; return primary(); }
		if (/[0-9.]/.test(text[pos] ?? "")) return number();
		const name = identifier();
		if (name === "round" || name === "abs") {
			eat("(");
			const first = expression();
			let digits = 0;
			skip();
			if (text[pos] === ",") { pos++; digits = number(); }
			eat(")");
			if (name === "abs") return Math.abs(first);
			const factor = Math.pow(10, digits);
			return Math.round(first * factor) / factor;
		}
		if (name.startsWith("@")) {
			const got = memberAt(value, name.slice(1));
			if (typeof got !== "number") fail("@" + name.slice(1) + " is " + (got === undefined ? "absent from what the call returned" : typeof got) + ", and the formula reads it as a number");
			return got;
		}
		return fail(name + " is not @member, a number, round or abs — the formula grammar is arithmetic over the returned members, nothing else");
	};
	const factor = (): number => {
		let left = primary();
		for (;;) {
			skip();
			const op = text[pos];
			if (op !== "*" && op !== "/") return left;
			pos++;
			const right = primary();
			if (op === "/" && right === 0) fail("divides by zero — a formula that cannot be evaluated is not a relation");
			left = op === "*" ? left * right : left / right;
		}
	};
	const term = (): number => {
		let left = factor();
		for (;;) {
			skip();
			const op = text[pos];
			if (op !== "+" && op !== "-") return left;
			pos++;
			left = op === "+" ? left + factor() : left - factor();
		}
	};
	function expression(): number { return term(); }
	const answer = expression();
	skip();
	if (pos !== text.length) fail("trailing input at offset " + pos);
	return answer;
}
import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import projected from "./tool-executor-contract-rows.json";

const ROWS = (projected.rows ?? projected) as Vector[];

// This file, and the one row a child process is selecting. Absent in the
// parent run: every row executes there, and a row with fixtures forks.
const SELF = import.meta.path;
const SELECTED = process.env.SCALA_CONTRACT_ROW;

if (!Array.isArray(ROWS)) {
	throw new Error("./tool-executor-contract-rows.json must project an array of rows — the runner executes registry rows, never a hand-written case list");
}

const PKG = "@teamscala/tool-executor";

// import.meta.dir is this FILE's directory (bun's own value, extension-
// independent) — row modules are repo-relative, so the package root is the
// nearest enclosing directory carrying a package.json, walked up: suites
// render CO-LOCATED at any depth (1.3.0), and a fixed two-levels-up guess
// resolves src/tier-selector/TierSelector/ suites against src/.
const ROOT = (() => {
	let dir = import.meta.dir;
	for (let depth = 0; depth < 8; depth++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		dir = join(dir, "..");
	}
	throw new Error("no package.json above " + import.meta.dir + " — a contract suite renders inside a package");
})();

type Vector = Record<string, any> & { suite_type: string; slug: string };

// ONE recording map per row, shared by the two things that record: a stub
// export a row declared (fixtures.stubs[].record) and an injected
// collaborator an ARG declared ($fn.records). Both are asserted through
// the same `outcomes` vocabulary, so a row that injects a recording client
// and a row that stubs one are the same case shape. Reset per row in
// runRow, so a recorder never answers a row that declared no such call.
let ACTIVE_RECORDERS: Record<string, { args: unknown[] }[]> = {};
function declareRecorder(name: string): void {
	(ACTIVE_RECORDERS[name] ??= []);
}
function recordCall(name: string, args: unknown[]): void {
		(ACTIVE_RECORDERS[name] ??= []).push({ args });
}

// The ONE arg encoding: a declared error value is data, never a literal
// in the row's JSON — {"$error": {"class", "module"?, "args"}}.
// A JSON null at an ARG position is ABSENCE, never a value (row-writer
// convention 2026-09-28 19:50 #1): it decodes to `undefined`, which is what
// a Rust None and an omitted optional both mean. A null under `expect` is
// the opposite — a VALUE, asserted with toEqual(null).
async function decodeValue(value: unknown): Promise<unknown> {
	if (value === null) return undefined;
	if (value !== null && typeof value === "object" && "$error" in (value as object)) {
		const spec = (value as { $error: { class: string; module?: string; args?: unknown[] } }).$error;
		const ctor = spec.module
			? ((await import(spec.module)) as Record<string, any>)[spec.class]
			: (globalThis as Record<string, any>)[spec.class];
		if (typeof ctor !== "function") throw new Error("unconstructible error class: " + spec.class);
		return new ctor(...(spec.args ?? []));
	}
	// A FUNCTION-valued arg: a block export is built from thunks, and JSON
	// cannot spell one. {"$fn": {"returns": <any>}} is the zero-arg thunk
	// returning that value; {"$fn": {"throws": <any>}} is the one raising
	// it. Decoded HERE, at build time, so the closure captures a finished
	// value rather than an unresolved promise.
	//
	// 1.4.0 — THE RECORDED ARG. An INJECTED COLLABORATOR is the commonest
	// thing a subject's test needs and the thing JSON cannot spell: a
	// database client, a context object, a recording accessor — every
	// member a function the subject CALLS, and the row needing to see
	// what it was called WITH. Two members make that expressible:
	//   records  — names a recorder; every invocation appends {args}, and
	//     the row asserts it through the SAME `outcomes` vocabulary a
	//     stub's recording uses (one assertion surface, no second one).
	//   respond  — answers PER SHAPE, the arg-side twin of a stub's
	//     when_sql_contains: an ordered list of arms, first whose
	//     args_contains appears in the recorded call wins. A call
	//     matching no arm REFUSES naming the declared shapes — guessing
	//     an answer no row declared is a case asserting something never
	//     was true (the same contract stubReturn states for SQL).
	// A respond list with no fallback `returns` is refused: every call
	// the row did not shape is then a call it never answered for.
	// {"$date": "<ISO>"} is the Date a row cannot spell in JSON: a
	// subject that calls toISOString() on a decoded STRING reads a
	// value the row never wrote (measured 2026-10-05, user-prefs:
	// getUserPreference's row.updated_at.toISOString()). An invalid
	// instant is refused by name rather than becoming Invalid Date.
	if (typeof value === "object" && "$date" in (value as object)) {
		const instant = new Date(String((value as { $date: unknown }).$date));
		if (Number.isNaN(instant.getTime())) throw new Error("$date " + JSON.stringify((value as { $date: unknown }).$date) + " is not an instant this runtime can read");
		return instant;
	}
	// THE IMPORTED-VALUE ARM. Some subjects take a VALUE THE ROW CAN ONLY
	// NAME — a schema, a frozen table, an enum object. A schema suite is
	// the commonest case on the platform: every claim in
	// foundation-db-validation-ts is `safeParse(SomeSchema, config)`, and
	// no JSON arg can carry a valibot schema. {"$import": {module,
	// export}} resolves the named export from the named module and hands
	// the subject the real object, so the row states the schema BY NAME
	// and the verdict it owes. The module is resolved from ROOT exactly
	// as a subject's own module is, so a row in one package reaches a
	// sibling by the same path a caller would write.
	if (typeof value === "object" && value !== null && "$import" in (value as object)) {
		const spec = (value as { $import: { module?: string; export?: string } }).$import;
		if (spec === null || typeof spec !== "object" || typeof spec.module !== "string" || typeof spec.export !== "string") throw new Error("$import needs {module, export} — a value a row can only NAME is named by the module it lives in and the export it is called");
		const mod = (await import(spec.module.includes("/") ? join(ROOT, spec.module) : spec.module)) as Record<string, unknown>;
		if (!(spec.export in mod)) throw new Error("no export " + spec.export + " in " + spec.module + " — $import named a value that module does not carry");
		return mod[spec.export];
	}
	if (typeof value === "object" && "$fn" in (value as object)) {
		const spec = (value as { $fn: { returns?: unknown; throws?: unknown; returns_by_call?: unknown[]; records?: string; respond?: Vector[]; calls_arg?: boolean; arg?: unknown } }).$fn;
		// THE CALLBACK ARM. A transactional API is not a collaborator with
		// members — it TAKES a function and hands it the unit of work:
		// prisma.$transaction(async (tx) => { ...everything on tx... }). A
		// stub that returns a value never runs the callback, so every row
		// about what a transaction did asserted nothing (measured
		// 2026-10-05: createInitiative's eight cases). {"calls_arg": true}
		// calls the function it is given with `arg` (the tx to hand it —
		// the same client the row injected, so the callback operates on
		// the recording) and returns the callback's answer, so the
		// subject sees the value its transaction produced. A non-function
		// argument is refused by name: a callback arm handed a value
		// would run the subject's work on nothing.
		if (spec.calls_arg === true) {
			const handed = spec.arg === undefined ? undefined : await decodeValue(spec.arg);
			return async (...callArgs: unknown[]) => {
				if (spec.records !== undefined) recordCall(String(spec.records), callArgs);
				const callback = callArgs[0];
				if (typeof callback !== "function") throw new Error("$fn declares calls_arg but was handed " + (callback === undefined ? "nothing" : typeof callback) + " where the callback goes — a transaction that runs no callback runs no work");
				return await (callback as (unit: unknown) => unknown)(handed);
			};
		}
		if (spec.records !== undefined) declareRecorder(String(spec.records));
		const arms = Array.isArray(spec.respond) ? (spec.respond as Vector[]) : [];
		// THE SUCCESSIVE-ANSWER ARM, on an INJECTED ARG. Some collaborators
		// are stateful in a way a single return cannot express: pactl
		// flickers, so a retry helper must see a MISS on the first read
		// and a HIT on the second. {"returns_by_call": [A, B, …]}
		// answers the Nth call with the Nth value and repeats the last
		// after that; an entry may be {"$throws": …} so ONE call can fail
		if (Array.isArray(spec.returns_by_call)) {
			const sequence = (spec.returns_by_call as unknown[]).map((entry) => decodeStubReturn(entry));
			if (sequence.length === 0) throw new Error("$fn declares an empty returns_by_call — a sequence with no answers is a collaborator that can never be called");
			let seen = 0;
			return async (...callArgs: unknown[]) => {
				if (spec.records !== undefined) recordCall(String(spec.records), callArgs);
				const index = Math.min(seen, (sequence as unknown[]).length - 1);
				seen++;
				const answer = (sequence as unknown[])[index] as { $throws?: unknown };
				if (answer !== null && typeof answer === "object" && "$throws" in answer) throw new Error(String(answer.$throws));
				return await answer;
			};
		}
		if (arms.length > 0 && spec.returns === undefined) {
			throw new Error("$fn declares a respond list with no fallback returns — every call no arm shapes is a call the row never answered for");
		}
		if (spec.returns !== undefined) {
			// decodeStubReturn, NOT decodeValue. A returns payload is DATA the
			// subject will read, and a null inside it is a real column value —
			// decodeValue encodes ARGUMENT null as undefined (a row writing null
			// means absent), and applying that to a return value silently
			// rewrote every nullable column of a stubbed database row. The
			// subject's own schema then refused the row it had been handed:
			// "Expected string but received undefined" on four members,
			// with the cause two layers from the row that wrote them
			// (measured: resolver-engine's loadPage, whose PuckPageRowSchema
			// requires meta_title/meta_description to be string|null).
			const answer = decodeStubReturn(spec.returns);
			const raisedSpec = spec.throws === undefined ? undefined : await decodeValue(spec.throws);
			return (...callArgs: unknown[]) => {
				if (spec.records !== undefined) recordCall(String(spec.records), callArgs);
				for (const arm of arms) {
					const needle = arm.args_contains === undefined ? undefined : String(arm.args_contains);
					if (needle === undefined || JSON.stringify(callArgs).includes(needle)) {
						if (arm.throws !== undefined) throw arm.throws;
						return arm.returns;
					}
				}
				if (arms.length > 0) {
					throw new Error("$fn recorded arm no answer matches the call " + JSON.stringify(callArgs).slice(0, 120) + " — declared shapes: " + arms.map((arm) => JSON.stringify(arm.args_contains)).join(", "));
				}
				if (raisedSpec !== undefined) throw raisedSpec;
				return answer;
			};
		}
		if (spec.throws !== undefined) {
			const raised = await decodeValue(spec.throws);
			return (...callArgs: unknown[]) => {
				if (spec.records !== undefined) recordCall(String(spec.records), callArgs);
				throw raised;
				};
		}
		throw new Error("$fn declares neither returns nor throws — a function whose behaviour is undeclared is a case the runner cannot run");
	}
	// A TemplateStringsArray is an ARRAY carrying a non-enumerable `raw`
	// marker, and it must reach the subject as itself: the runtime's own
	// tagged templates freeze it, and a subject may read strings.raw. The
	// element-wise map below would hand back a fresh plain array and drop
	// the marker, so the subject could not tell a template from a binds
	// array and the row's binds outcome could not read it. A template
	// passes through UNTOUCHED; every other array is decoded element-wise,
	// which is what lets a $fn sit inside an array argument.
	if (Array.isArray(value)) return "raw" in (value as object) ? value : await Promise.all(value.map(decodeValue));
	// Composite args are walked: a $error or $fn nested at a member position is
	// the same encoding one level down, not a literal object that happens to
	// contain one.
	if (typeof value === "object") {
		// A TemplateStringsArray IS an array, so the walk below would
		// rebuild it as a plain object and drop the non-enumerable `raw`
		// marker that tells a template apart from a binds array — the
		// subject would then receive a non-array where its signature
		// promises strings. Arrays pass through UNWALKED: an array arg
		// is data, and a $fn inside one is spelled by the caller as a
		// positional value, not as a member encoding.
		if (Array.isArray(value)) return value;
		const walked: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			walked[key] = await decodeValue(inner);
		}
		return walked;
	}
	return value;
}

// Resolve the EXPORT, without calling it: the shape of a class, a frozen
// table or a namespace is a contract a call cannot state, so this is the
// half of the pair callExport below cannot do.
async function loadExport(modulePath: string, exportName: string): Promise<unknown> {
	// A SPECIFIER CARRYING A SLASH IS A PATH, a bare word is a PACKAGE.
	// Joining a bare word would look for <root>/valibot and miss, which
	// is how a row whose subject is a library call (valibot's
	// safeParse) could never run; joining is right for every path a
	// caller writes, whether it is written ./x.ts or src/x.ts.
	const specifier = modulePath.includes("/") ? join(ROOT, modulePath) : modulePath;
	const mod = (await import(specifier)) as Record<string, any>;
	if (!(exportName in mod)) throw new Error("no export " + exportName + " in " + modulePath);
	return mod[exportName];
}

async function callExport(modulePath: string, exportName: string, decodedArgs: unknown[]): Promise<unknown> {
	const fn = await loadExport(modulePath, exportName);
	if (typeof fn !== "function") throw new Error("export " + exportName + " in " + modulePath + " is not a function — a row that wants its shape declares expect.export_shape");
	// Decoding happened at the CALLER, once. Decoding here too would walk an
	// already-decoded $error instance a second time — an Error object has no
	// enumerable own keys, so the walk would collapse it to {} and the row
	// would assert against a value the subject never received.
	return await fn(...decodedArgs);
}

// THE TAGGED-TEMPLATE ARM. A subject written as a tagged template
// (queryRows`SELECT ... ${v}`) receives a TemplateStringsArray as its
// FIRST parameter and the interpolated values as the rest. A row cannot
// spell that array in JSON — and passing a bare string instead makes the
// subject index it CHARACTER BY CHARACTER, which reads as a wrong SQL
// needle rather than as a malformed call. `template: {strings, values}`
// builds the real array: a frozen array carrying the `raw` property the
// runtime's own tagged templates carry, so a subject that reads
// strings.raw sees the joined source exactly as it would at the call
// site. Interpolated values go through the SAME decoder as args[], so a
// $fn value is a recording stub in a template too.
const TEMPLATE_SPELLING = "template";
function isTemplate(spec: unknown): boolean {
	return spec !== null && typeof spec === "object" && TEMPLATE_SPELLING in (spec as object);
}
function templateStrings(parts: string[]): TemplateStringsArray {
	const out = parts.slice() as string[] & { raw: readonly string[] };
	Object.defineProperty(out, "raw", { value: parts, enumerable: false, writable: false });
	return Object.freeze(out) as unknown as TemplateStringsArray;
}
function decodeTemplate(slug: string, spec: Record<string, unknown>): unknown[] {
	const parts = spec[TEMPLATE_SPELLING];
	if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) throw new Error("row " + slug + " is malformed: template is the ordered array of STATIC string parts between the interpolations — a tagged template's literals, never the statement with the value spliced in");
	const values = spec.values === undefined || spec.values === null ? [] : spec.values;
	if (!Array.isArray(values)) throw new Error("row " + slug + " is malformed: template values is the positional array of interpolated values, got " + typeof values);
	if (values.length !== parts.length - 1) throw new Error("row " + slug + " is malformed: template declares " + values.length + " values for " + parts.length + " string parts — a tagged template has exactly one interpolation per gap, so values.length must be parts.length - 1");
// Values are passed through RAW: expectCall runs them through the same
// decodeValue as args[], so a $fn here is a recording stub exactly as it
// would be in a positional argument.
	return [templateStrings(parts as string[]), ...(values as unknown[])];
}

function applyEnv(env?: Record<string, string>): () => void {
	const before: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		before[key] = process.env[key];
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function assertWellFormed(row: Vector): void {
	const bad = (msg: string): never => {
		throw new Error("row " + row.slug + " is malformed: " + msg);
	};
	if (PKG !== "*" && row.package !== PKG) bad("package " + JSON.stringify(row.package) + " — expected " + JSON.stringify(PKG));
	if (row.suite_type === "function_call") {
		if (typeof row.export !== "string" || row.export.length === 0) bad("export must be a non-empty string");
		if (row.args === null || row.env === null) bad("args and env must be arrays/objects, never null — null and an absent key are different states");
		if (row.args !== undefined && !Array.isArray(row.args)) bad("args must be a positional array (ruling 18:02 #1)");
		if (row.args === undefined && row.template === undefined) bad("declares neither args nor template — a call needs its arguments, and an absent args and an empty one are different states");
		if (row.expect !== undefined && row.expect_error !== undefined) bad("declares both expect and expect_error — the arms are XOR");
		if (row.expect_throw !== undefined && (row.expect !== undefined || row.expect_error !== undefined)) bad("declares expect_throw beside expect or expect_error — the arms are XOR: a throw is either synchronous (expect_throw) or awaited (expect_error), and one call cannot be both");
		if (row.expect_void !== undefined) {
			if (row.expect_void !== true) bad("expect_void must be true — it is the VOID claim (the call returns nothing), and false would assert a value the row never spells");
			if (row.expect !== undefined || row.expect_error !== undefined) bad("declares expect_void beside expect or expect_error — the arms are XOR: a void subject returns nothing, so there is no value to compare and no error to match");
		} else if (row.expect === undefined && row.expect_error === undefined && row.expect_throw === undefined && !hasThen(row) && !hasCallEach(row) && row.then_return === undefined) bad("declares neither expect nor expect_error nor expect_void nor expect_throw, and no then, then_call_each or then_return steps — a row that asserts nothing asserts nothing");
		// null and an absent key are DIFFERENT states everywhere in a row: expect
		// null is a value (asserted with toEqual(null)), but a null args/env is a
		// malformed row — it is refused, never silently substituted.
		if (row.args === null || row.env === null) bad("args and env must be arrays/objects, never null");
		assertOneAxis("row " + row.slug, row.expect, row.args as unknown[] | undefined, row.expect_error);
	} else if (row.suite_type === "fs_flow") {
		if (!Array.isArray(row.steps) || (row.steps as unknown[]).length === 0) bad("fs_flow needs non-empty ordered steps");
		for (let i = 0; i < (row.steps as unknown[]).length; i++) {
			const step = (row.steps as any[])[i];
			if (typeof step.call !== "string" || step.call.length === 0) bad("steps[" + i + "].call must be a non-empty string");
			if (step.args === null) bad("steps[" + i + "].args must be a positional array, never null — null and an absent key are different states");
			if (step.args !== undefined && !Array.isArray(step.args)) bad("steps[" + i + "].args must be a positional array");
			if (step.expect === undefined && step.expect_error === undefined && step.expect_void === undefined) bad("steps[" + i + "] asserts nothing");
			if (step.expect_void !== undefined) {
				if (step.expect_void !== true) bad("steps[" + i + "].expect_void must be true — it is the VOID claim, and false would assert a value the row never spells");
				if (step.expect !== undefined || step.expect_error !== undefined) bad("steps[" + i + "] declares expect_void beside a value arm — the arms are XOR");
			}
			assertOneAxis("steps[" + i + "] of row " + row.slug, step.expect, step.args as unknown[] | undefined, step.expect_error);
		}
	} else {
		bad("unknown suite_type " + JSON.stringify(row.suite_type));
	}
}

// THE RETURNED-MEMBER ARM's executor: each step calls one member of what
// the call returned and asserts its answer. A path may walk members
// ("rows.first") so a nested contract is reachable without the row
// building intermediate objects it never asserted.
async function runThen(slug: string, returned: unknown, steps: Vector[]): Promise<void> {
	if (!Array.isArray(steps)) throw new Error("row " + slug + " is malformed: then is an ordered array of {call, args?, expect?, expect_error?} steps");
	for (const step of steps) {
		if (step === null || typeof step !== "object" || typeof step.call !== "string" || step.call.length === 0) throw new Error("row " + slug + " is malformed: a then step names no call");
		const parts = String(step.call).split(".");
		let target: any = returned;
		for (const part of parts) {
			if (target === null || target === undefined) throw new Error("row " + slug + " calls " + step.call + " but the value it walks is " + String(target));
			target = target[part];
		}
		if (typeof target !== "function") throw new Error("row " + slug + " calls " + step.call + " and it is " + (target === undefined ? "absent from what the call returned" : typeof target) + " — a member the return does not carry cannot be a contract");
		const stepArgs = step.args === undefined || step.args === null ? [] : step.args;
		if (!Array.isArray(stepArgs)) throw new Error("row " + slug + " is malformed: then step " + step.call + " args is a positional array");
		if (step.args !== undefined && step.template !== undefined) throw new Error("row " + slug + " then step " + step.call + " declares both args and template — two ways to say the same call is a row whose intent is unreadable");
		if (step.args === undefined && step.template === undefined) throw new Error("row " + slug + " then step " + step.call + " declares neither args nor template — a member call needs its arguments");
		const effectiveArgs = step.template !== undefined && step.template !== null ? decodeTemplate(slug, step.template as Record<string, unknown>) : (stepArgs as unknown[]);
		const called = target(...(await Promise.all(effectiveArgs.map(decodeValue))));
		if (step.expect_error !== undefined) {
			await expect(Promise.resolve(called)).rejects.toThrow(String(step.expect_error));
			continue;
		}
		const answer = await called;
		if (step.expect === undefined) continue;
		if (isStructural(step.expect)) assertStructural(slug, answer, step.expect);
		else if (isStructural(step.expect) && step.expect[UNDEFINED_SPELLING] === true) expect(answer).toBeUndefined();
		else expect(answer).toEqual(step.expect);
	}
}

async function expectCall(row: Vector, exportName: string, args: unknown[]): Promise<void> {
	const restore = applyEnv(row.env);
	try {
		await withStubs(row, async () => {
			// THE HOIST. A subject whose collaborators arrive by CONFIGURE rather
			// than by argument (configureWorkItems({emailSender}), the
			// configured-primitive contract every package shares) cannot be
			// reached by a row that only names the subject: the row has no way to
			// stand the binding up. hoist[] is that way — each step is a call in
			// the row's OWN module (its own `module` names another), run IN
			// ORDER before the subject call, with the same arg decoder and the
			// same recorders. It runs inside withStubs, so a configure step
			// sees the row's stubs — a configured sender can itself be a
			// $fn arg whose calls the row asserts. A step naming no export
			// is refused: a binding nobody can call is a case the runner
			// would have run without.
			if (row.hoist !== undefined && row.hoist !== null) {
				if (!Array.isArray(row.hoist)) throw new Error("row " + row.slug + " is malformed: hoist is an ordered array of call steps, got " + typeof row.hoist);
				for (const step of row.hoist as Vector[]) {
					if (step === null || typeof step !== "object" || typeof step.export !== "string" || step.export.length === 0) throw new Error("row " + row.slug + " is malformed: a hoist step names no export — each step is {export, args?, module?}");
					const stepArgs = step.args === undefined || step.args === null ? [] : step.args;
					if (!Array.isArray(stepArgs)) throw new Error("row " + row.slug + " is malformed: hoist step " + step.export + " args is a positional array, got " + typeof stepArgs);
					await callExport(String(step.module ?? row.module), String(step.export), await Promise.all((stepArgs as unknown[]).map(decodeValue)));
				}
			}
			if (row.expect_void === true) {
				expect(await callExport(row.module, exportName, await Promise.all(args.map(decodeValue)))).toBeUndefined();
			} else if (isExportShape(row.expect)) {
				assertStructural(row.slug, await loadExport(row.module, exportName), (row.expect as Record<string, unknown>)[EXPORT_SHAPE]);
			} else if (row.expect_error === undefined && row.expect_throw === undefined) {
				const decoded = await Promise.all(args.map(decodeValue));
				if (isStructural(row.expect) && (row.expect as Record<string, unknown>)[ARG_SHAPE] !== undefined) argTarget(row.slug, row.expect as Record<string, unknown>, decoded);
				const value = await callExport(row.module, exportName, decoded);
				// THE RETURNED-MEMBER ARM. A factory is a contract only through
				// what it hands back: createQueryRaw(client) is the client binding
				// nobody can reach unless the row can CALL a member of the return,
				// and resolveModelOrm's shape is the same. `then: [{call, args?,
				// expect | expect_error}]` calls each declared member on what the
				// call returned, in order, with the same arg decoder and the same
				// recorders, and asserts each answer. A member the return does not
				// carry is refused by name: a call into undefined is a row that
				// cannot mean anything.
				if (row.then !== undefined && row.then !== null) await runThen(row.slug, value, row.then as Vector[]);
				if (row.then_call_each !== undefined && row.then_call_each !== null) await callEach(row.slug, value, row.then_call_each as Vector[]);
				// THEN_RETURN: the subject's OWN RETURN is the callable. A factory —
				// makeApifyGatherRunner(sources, deps) returns the runner a row then
				// invokes — is not a member of anything, so `then` cannot reach it.
				if (row.then_return !== undefined && row.then_return !== null) await callReturned(row.slug, value, row.then_return as Vector);
				if (isStructural(row.expect)) {
					if ((row.expect as Record<string, unknown>)[ARG_SHAPE] !== undefined) assertArgShape(row.slug, row.expect as Record<string, unknown>, decoded);
					else assertStructural(row.slug, value, row.expect);
				}
				else if (isTextSpec(row.expect)) assertText(row.slug, value, row.expect as Record<string, unknown>);
				// THE UNDEFINED SPELLING. `expect: null` is a VALUE (toEqual(null)) and a
			// function that resolves NOTHING is a different state again — a row
			// spelling it `{"$undefined": true}` claims exactly that, and any other
			// value under the key is refused rather than read as truthy (measured
			// 2026-10-05: resolveUserOrganisationId returns undefined when the user
			// has no membership, and toEqual(null) would not have said so).
				else if (isStructural(row.expect) && UNDEFINED_SPELLING in (row.expect as Record<string, unknown>)) {
					if ((row.expect as Record<string, unknown>)[UNDEFINED_SPELLING] !== true) throw new Error("row " + row.slug + " is malformed: " + UNDEFINED_SPELLING + " is the claim that the call returned nothing — it takes true, and any other value is a row asserting a truthiness nobody declared");
					expect(value).toBeUndefined();
				}
				else expect(value).toEqual(row.expect);
			} else if (row.expect_throw !== undefined) {
				// A SYNC throw is a different contract from a rejected promise:
				// queryRows throws before it returns its promise (the registry
				// accessor runs first), and a caller that expected a promise
				// would be told a different thing than one that got a rejection.
				// expect_error cannot say that: awaiting a call that threw leaves
				// no promise to await, and the row would fail on the throw it
				// was asserting.
				const throwArgs = await Promise.all(args.map(decodeValue));
				// callExport is async, so it must be RESOLVED to the function
				// before the throw can be observed: an async wrapper turns a
				// synchronous throw into a rejected promise, and toThrow on
				// the wrapper would see the rejection, not the throw. Awaiting
				// the FUNCTION (not its result) gets the raw export, whose call
				// throws in the caller's stack exactly as a direct call would.
				const syncExport = await loadExport(row.module, exportName);
				if (typeof syncExport !== "function") throw new Error("export " + exportName + " in " + row.module + " is not a function — expect_throw needs a callable to throw from");
				expect(() => (syncExport as (...a: unknown[]) => unknown)(...throwArgs)).toThrow(String(row.expect_throw));
			} else {
				const raised = callExport(row.module, exportName, await Promise.all(args.map(decodeValue)));
				await expect(raised).rejects.toThrow(row.expect_error);
			}
		});
	} finally {
		restore();
	}
}

// ------------------------------------------------------ structural expect
// A step names its own target: the live fs_flow rows spell call as
// "path/to/module.ts:exportName" and the arm admits no row module, so a
// step that declares no row module is split at its LAST colon. A call that
// can neither be split nor resolved is refused BY NAME.
function stepTarget(row: Vector, step: any): [string, string] {
	if (row.module !== undefined && row.module !== null && row.module !== "") return [String(row.module), String(step.call)];
	const spelled = String(step.call);
	const colon = spelled.lastIndexOf(":");
	if (colon <= 0 || colon === spelled.length - 1) {
		throw new Error("row " + row.slug + " is malformed: a step with no row module spells call as <module>:<export>, got " + JSON.stringify(spelled));
	}
	return [spelled.slice(0, colon), spelled.slice(colon + 1)];
}

const STRUCTURAL_VERBS = ["has_members", "member_is", "member_equals", "reads_resolve", "member_equals_expression"] as const;
const EXPORT_SHAPE = "export_shape";
const ARG_SHAPE = "arg_shape";
const UNDEFINED_SPELLING = "$undefined";
const TEXT_VERBS = ["contains_text", "absent", "in_order", "repeated"] as const;
// THE NESTED-MESSAGE VERB. Every other text verb asserts on the string the
// call RETURNED, which is the wrong subject whenever the string is nested:
// a schema refusal carries its message in result.issues[0].message, and a
// refusal that does not NAME the rule is a wall rather than a signpost —
// the writer who typed a bad scope prefix needs to be told which rule
// refused. `contains_in: {path, needles}` reads the string AT that path
// and applies contains_text to it, so "the message names this rule" is a
// claim a row can make. The path walks members and numeric indices; a path
// that does not resolve to a string is refused by name rather than
// asserted against undefined.
function containsIn(slug: string, value: unknown, spec: { path?: string; needles?: string[] }): void {
	if (spec === null || typeof spec !== "object" || typeof spec.path !== "string" || !Array.isArray(spec.needles)) throw new Error("row " + slug + " is malformed: contains_in needs {path, needles}");
	const found = memberAt(value, spec.path);
	if (typeof found !== "string") throw new Error("row " + slug + " is malformed: contains_in reads " + spec.path + " and it is " + (found === undefined ? "absent from what the call returned" : typeof found) + ", not a string to read");
	for (const needle of spec.needles as string[]) {
		if (!(found as string).includes(needle)) throw new Error("row " + slug + " text expect did not hold: " + spec.path + " has no " + JSON.stringify(needle));
	}
}

function isTextSpec(spec: unknown): boolean {
	return (
		spec !== null &&
		typeof spec === "object" &&
		!Array.isArray(spec) &&
		Object.keys(spec as object).some((key) => (TEXT_VERBS as readonly string[]).includes(key) || key === "contains_in")
	);
}

function assertText(slug: string, value: unknown, spec: Record<string, unknown>): void {
	const bad = (msg: string): never => {
		throw new Error("row " + slug + " text expect did not hold: " + msg);
	};
	// contains_in addresses a NESTED string, so it is dispatched BEFORE
	// the string check below: the value it reads is the one at the
	// path, not the value the call returned.
	if (spec.contains_in !== undefined) {
		containsIn(slug, value, spec.contains_in as { path?: string; needles?: string[] });
		return;
	}
	if (typeof value !== "string") {
		throw new Error("row " + slug + " is malformed: a text expect asserts a returned string, got " + (value === null ? "null" : typeof value));
	}
	const text = value as string;
	for (const verb of Object.keys(spec)) {
		if (!(TEXT_VERBS as readonly string[]).includes(verb)) {
			throw new Error("row " + slug + " is malformed: text expect " + verb + " is not a declared verb " + JSON.stringify(TEXT_VERBS) + " — a predicate this runner does not understand is a case it stopped asserting");
		}
		const needles = spec[verb];
		if (verb === "contains_text") {
			for (const needle of needles as string[]) if (!text.includes(needle)) bad("the text has no " + JSON.stringify(needle));
		} else if (verb === "absent") {
			for (const needle of needles as string[]) if (text.includes(needle)) bad("the text carries " + JSON.stringify(needle));
		} else if (verb === "in_order") {
			let after = -1;
			let previous = "the start";
			for (const marker of needles as string[]) {
				const at = text.indexOf(marker);
				if (at === -1) bad(JSON.stringify(marker) + " is not in the text at all");
				if (at <= after) bad(JSON.stringify(marker) + " is not after " + previous);
				after = at;
				previous = JSON.stringify(marker);
			}
		} else {
			const rep = needles as { pattern?: unknown; count?: unknown; group?: unknown };
			if (typeof rep.pattern !== "string" || typeof rep.count !== "number") {
				throw new Error("row " + slug + " is malformed: repeated needs {pattern, count} and an optional group — how many times the pattern matches, and which capture must not drift between the matches");
			}
			let matches: RegExpMatchArray[];
			try {
				matches = [...text.matchAll(new RegExp(rep.pattern, "g"))];
			} catch (err) {
				throw new Error("row " + slug + " is malformed: repeated.pattern is not a usable regex — " + String(err));
			}
			if (matches.length !== rep.count) bad("the pattern matched " + matches.length + " times, not the declared " + rep.count);
			if (rep.group !== undefined) {
				const group = rep.group as number;
				const first = matches[0]?.[group];
				if (first === undefined) bad("capture group " + group + " took no part in the first match");
				for (const match of matches) {
					if (match[group] !== first) bad("capture group " + group + " differs between matches: " + JSON.stringify(first) + " vs " + JSON.stringify(match[group]) + " — the two copies of this text must be the same set");
				}
			}
		}
	}
}


function isExportShape(spec: unknown): boolean {
	return (
		spec !== null &&
		typeof spec === "object" &&
		!Array.isArray(spec) &&
		(spec as Record<string, unknown>)[EXPORT_SHAPE] !== undefined
	);
}

function assertOneAxis(where: string, spec: unknown, args: unknown[] | undefined, expectError: unknown): void {
	const bad = (msg: string): never => {
		throw new Error(where + " is malformed: " + msg);
	};
	if (isExportShape(spec)) {
		const declared = (spec as Record<string, unknown>)[EXPORT_SHAPE];
		if (declared === null || typeof declared !== "object" || Array.isArray(declared)) bad(EXPORT_SHAPE + " must be a structural spec object");
		if (expectError !== undefined) bad(EXPORT_SHAPE + " with expect_error — no call is made, so nothing is raised to match");
		if (args !== undefined && args.length > 0) bad(EXPORT_SHAPE + " declares args — the export is not called, so nothing receives them");
		for (const verb of Object.keys(spec as object)) {
			if (verb !== EXPORT_SHAPE) bad("expect declares " + verb + " alongside " + EXPORT_SHAPE + " — one row states one axis; a row that wants both is two rows");
		}
		return;
	}
	if (isRenderRow(spec, args)) {
		if (args !== undefined && args.length > 1) bad("a render row takes at most one arg — the props object, not a positional list");
		if (spec === null || spec === undefined || typeof spec !== "object" || Array.isArray(spec)) return;
		for (const verb of Object.keys(spec as object)) {
			if (verb !== "render") bad("expect declares " + verb + " alongside render — one row states one axis; a row that wants both is two rows");
		}
		const renderSpec = (spec as Record<string, unknown>).render;
		if (renderSpec === null || typeof renderSpec !== "object" || Array.isArray(renderSpec)) bad("render must be a spec object");
		for (const verb of Object.keys(renderSpec as object)) {
			if (!(RENDER_VERBS as readonly string[]).includes(verb)) bad("render " + verb + " is not a declared verb " + JSON.stringify(RENDER_VERBS) + " — a predicate this runner does not understand is a case it stopped asserting");
		}
		const clickSelectors = (renderSpec as Record<string, unknown>).click;
		if (clickSelectors !== undefined) {
			if ((spec as Record<string, unknown>).expect_error !== undefined) bad("click beside expect_error — a row that expects the render to throw has nothing to click");
			const selectors = (Array.isArray(clickSelectors) ? clickSelectors : [clickSelectors]) as unknown[];
			if (selectors.length === 0) bad("click needs at least one selector");
			for (const selector of selectors) {
				if (typeof selector !== "string" || selector.length === 0) bad("click selectors must be non-empty strings, got " + JSON.stringify(selector));
			}
		}
		return;
	}
	if (spec === null || spec === undefined || typeof spec !== "object" || Array.isArray(spec)) return;
	if (isHook(spec)) {
		if ((spec as Record<string, unknown>).expect_error !== undefined) bad("hook beside expect_error — a hook row's failure is the mount or the act, and the runner rethrows it; there is no separate error claim to match");
		for (const verb of Object.keys(spec as object)) {
			if (verb !== "hook") bad("expect declares " + verb + " alongside hook — one row states one axis; a row that wants both is two rows");
		}
		const hookSpec = (spec as Record<string, unknown>).hook;
		if (hookSpec === null || typeof hookSpec !== "object" || Array.isArray(hookSpec)) bad("hook must be a spec object");
		for (const verb of Object.keys(hookSpec as object)) {
			if (!(HOOK_VERBS as readonly string[]).includes(verb)) bad("hook " + verb + " is not a declared verb " + JSON.stringify(HOOK_VERBS) + " — a verb this runner does not read is a claim the row never makes");
		}
		const resultSpec = (hookSpec as Record<string, unknown>).result;
		if (resultSpec === null || typeof resultSpec !== "object" || Array.isArray(resultSpec)) bad("hook needs a result — a hook row that asserts nothing asserts nothing");
		for (const verb of Object.keys(resultSpec as object)) {
			if (!(HOOK_RESULT_VERBS as readonly string[]).includes(verb)) bad("hook.result " + verb + " is not a declared verb " + JSON.stringify(HOOK_RESULT_VERBS) + " — a verb this runner does not read is a claim the row never makes");
		}
		if (Object.keys(resultSpec as object).length === 0) bad("hook.result declares no verb — a result spec with no verb asserts nothing");
		const fields = (resultSpec as Record<string, unknown>).field_equals;
		if (fields !== undefined) {
			if (fields === null || typeof fields !== "object" || Array.isArray(fields)) bad("hook.result.field_equals must be an object of field: value");
			if (Object.keys(fields as object).length === 0) bad("hook.result.field_equals declares no field — a field_equals with no field equals nothing");
		}
		const acts = (hookSpec as Record<string, unknown>).act;
		if (acts !== undefined) {
			if (!Array.isArray(acts)) bad("hook.act must be an ordered array — the acts run in the order the row declares them, because each sees the state the one before left");
			for (const [j, entry] of (acts as unknown[]).entries()) {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad("hook.act[" + j + "] must be an object {call, args}");
				const step = entry as Record<string, unknown>;
				for (const k of Object.keys(step)) {
					if (k !== "call" && k !== "args") bad("hook.act[" + j + "] declares " + k + " — an act names the returned callback to call and the arguments to call it with");
				}
				if (typeof step.call !== "string" || step.call.length === 0) bad("hook.act[" + j + "] must name the callback it calls — the hook's own return is what a row drives");
				if (step.args !== undefined && !Array.isArray(step.args)) bad("hook.act[" + j + "].args must be an array — a callback takes positional arguments");
			}
		}
		return;
	}
	if ((spec as Record<string, unknown>)[ARG_SHAPE] === undefined) return;
	const argSpec = (spec as Record<string, unknown>)[ARG_SHAPE];
	if (argSpec === null || typeof argSpec !== "object" || Array.isArray(argSpec)) bad(ARG_SHAPE + " must be a spec object");
	if (typeof (argSpec as { arg?: unknown }).arg !== "number") bad(ARG_SHAPE + ".arg must be declared — the positional index of the argument the subject mutates");
	for (const verb of Object.keys(spec as object)) {
		if (verb !== ARG_SHAPE) bad("expect declares " + verb + " alongside " + ARG_SHAPE + " — one row states one axis; a row that wants both is two rows");
	}
}

function isStructural(spec: unknown): boolean {
	return (
		isExportShape(spec) ||
		(spec !== null &&
		typeof spec === "object" &&
		!Array.isArray(spec) &&
		Object.keys(spec as object).some((key) =>
			(STRUCTURAL_VERBS as readonly string[]).includes(key) || key === ARG_SHAPE || key === UNDEFINED_SPELLING
		)
	)
	);
}

function argTarget(slug: string, spec: Record<string, unknown>, decoded: unknown[]): number {
	const target = (spec[ARG_SHAPE] as { arg?: unknown }).arg;
	if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= decoded.length) {
		throw new Error("row " + slug + " is malformed: " + ARG_SHAPE + ".arg must be an argument position this row declares (0.." + (decoded.length - 1) + "), got " + JSON.stringify(target));
	}
	return target;
}

function assertArgShape(slug: string, spec: Record<string, unknown>, decoded: unknown[]): void {
	assertStructural(slug, decoded[argTarget(slug, spec, decoded)], spec[ARG_SHAPE], "arg");
}

function memberAt(value: unknown, path: string): unknown {
	let at: any = value;
	for (const key of path.split(".")) {
		if (at === null || at === undefined) return undefined;
		at = at[key];
	}
	return at;
}

function assertStructural(slug: string, value: unknown, spec: any, declaration?: string): void {
	for (const verb of Object.keys(spec)) {
		if (verb === declaration) continue;
		// The $undefined claim is consumed by the CALLER (toBeUndefined on
		// what the call returned) and asserts nothing about a value's
		// members, so it is named here as well as in isStructural — a
		// spelling the runner recognises on one axis and refused on the
		// other is a row that cannot be written at all.
		if (verb === UNDEFINED_SPELLING) continue;
		if (!(STRUCTURAL_VERBS as readonly string[]).includes(verb)) {
			throw new Error(
			"row " + slug + " is malformed: structural expect " + verb +
			" is not a declared verb " + JSON.stringify(STRUCTURAL_VERBS) +
			" — a predicate this runner does not understand is a case it stopped asserting");
		}
	}
	const bad = (verb: string, detail: string): never => {
		throw new Error("row " + slug + " outcome " + verb + " did not hold: " + detail);
	};
	if (spec.has_members !== undefined) {
		for (const path of spec.has_members as string[]) {
			if (memberAt(value, path) === undefined) bad("has_members", path + " is not declared");
		}
	}
	if (spec.member_is !== undefined) {
		for (const [path, kind] of Object.entries(spec.member_is as Record<string, string>)) {
			const got = memberAt(value, path);
			if (got === undefined) bad("member_is", path + " is not declared");
			if (typeof got !== kind) bad("member_is", path + " is " + typeof got + ", the row declares " + kind);
		}
	}
	if (spec.member_equals !== undefined) {
		for (const [path, want] of Object.entries(spec.member_equals as Record<string, unknown>)) {
			expect(memberAt(value, path)).toEqual(want);
		}
	}
	if (spec.reads_resolve !== undefined) {
		for (const path of spec.reads_resolve as string[]) {
			try {
				memberAt(value, path);
			} catch (err) {
				bad("reads_resolve", "reading " + path + " threw " + String(err));
			}
		}
	}
// THE DERIVED-MEMBER ARM. Some contracts are ARITHMETIC, not equality: a
// cpu snapshot's normalised load is its one-minute load divided by its
// core count, rounded. No verb could say that — member_equals needs a
// literal the row cannot know (the load is read at call time), so the only
// faithful spelling left was to drop the assertion, which is the one thing
// this project forbids. `member_equals_expression: {path, equals, within?}`
// states it as an arithmetic FORMULA over the value's own members: each
// @name reads a member of what the call returned, the grammar is arithmetic
// only, and the parser refuses anything else — so a row can state a
// relation and never a computation of its own choosing.
	if (spec.member_equals_expression !== undefined) {
		const rel = spec.member_equals_expression as { path?: string; equals?: string; within?: number };
		if (rel === null || typeof rel !== "object" || typeof rel.path !== "string" || typeof rel.equals !== "string") bad("member_equals_expression", "needs {path, equals}");
		const got = memberAt(value, rel.path);
		if (typeof got !== "number") bad("member_equals_expression", rel.path + " is " + (got === undefined ? "absent from what the call returned" : typeof got) + ", the row states an arithmetic relation over a number");
		const want = arithmetic(rel.equals, value, slug);
		const within = rel.within === undefined ? 1e-9 : rel.within;
		if (!(Math.abs(got - want) <= within)) bad("member_equals_expression", rel.path + " is " + got + ", the row states it equals " + rel.equals + " over the returned members, which is " + want + " (within " + within + ")");
	}
}

const RENDER_VERBS = ["contains", "selector_present", "selector_absent", "click"] as const;
const HOOK_VERBS = ["act", "result"] as const;
const HOOK_RESULT_VERBS = ["field_equals", "contains", "absent"] as const;
function isHook(spec: unknown): boolean {
	return spec !== null && typeof spec === "object" && !Array.isArray(spec) && (spec as Record<string, unknown>).hook !== undefined;
}

function assertHookResult(slug: string, latest: unknown, spec: Record<string, unknown>): void {
	if (latest === null || typeof latest !== "object") throw new Error("row " + slug + " outcome hook did not hold: the hook returned " + JSON.stringify(latest) + ", which carries no field to read");
	const value = latest as Record<string, unknown>;
	for (const [field, want] of Object.entries((spec.field_equals ?? {}) as Record<string, unknown>)) {
		if (!(field in value)) throw new Error("row " + slug + " outcome hook did not hold: the hook returned no field " + field + ", so a claim over it asserts nothing");
		expect(value[field]).toEqual(want);
	}
	const text = JSON.stringify(value) ?? "";
	for (const needle of (spec.contains ?? []) as string[]) {
		if (!text.includes(needle)) throw new Error("row " + slug + " outcome hook did not hold: the hook's result does not contain " + JSON.stringify(needle));
	}
	for (const needle of (spec.absent ?? []) as string[]) {
		if (text.includes(needle)) throw new Error("row " + slug + " outcome hook did not hold: the hook's result still carries " + JSON.stringify(needle));
	}
}

const ELEMENT_MARKER = "$throw_on_render";

function isRender(spec: unknown): boolean {
	return (
		spec !== null &&
		typeof spec === "object" &&
		!Array.isArray(spec) &&
		(spec as Record<string, unknown>).render !== undefined
	);
}

function hasMarker(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasMarker);
	if (value !== null && typeof value === "object") {
		if (Object.keys(value as object).includes(ELEMENT_MARKER)) return true;
		for (const key of Object.keys(value as object)) {
			if (hasMarker((value as Record<string, unknown>)[key])) return true;
		}
	}
	return false;
}

function isRenderRow(spec: unknown, args: unknown[] | undefined): boolean {
	return isRender(spec) || (args !== undefined && args.some(hasMarker));
}

// The ONE element encoding: {"$throw_on_render": "<message>"} anywhere in
// the props tree becomes a component whose render raises that message — the
// throwing child a recovery contract is ABOUT. Anything else starting with $
// inside a render tree is refused: a marker this runner does not know would
// otherwise render as inert data and a case would silently stop asserting.
function buildElements(React: any, value: unknown, slug: string): unknown {
	if (Array.isArray(value)) return value.map((item, index) => {
		const builtItem = buildElements(React, item, slug);
		if (builtItem !== null && typeof builtItem === "object" && (builtItem as Record<string, unknown>).$$typeof !== undefined) return React.cloneElement(builtItem, { key: String(index) });
		return builtItem;
	});
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Object.keys(record).includes(ELEMENT_MARKER)) {
			if (typeof record[ELEMENT_MARKER] !== "string") throw new Error("row " + slug + " is malformed: " + ELEMENT_MARKER + " takes the error message string, got " + JSON.stringify(record[ELEMENT_MARKER]));
			const message = record[ELEMENT_MARKER] as string;
			return React.createElement(function Thrower(): never {
				throw new Error(message);
			});
		}
		const built: Record<string, unknown> = {};
		for (const key of Object.keys(record)) {
			if (key.startsWith("$")) throw new Error("row " + slug + " is malformed: element marker " + key + " is not declared — a marker this runner does not know is a child that would render as inert data");
			built[key] = buildElements(React, record[key], slug);
		}
		return built;
	}
	return value;
}

function assertRenderSpec(slug: string, container: HTMLElement, spec: any): void {
	const text = container.textContent ?? "";
	const bad = (verb: string, detail: string): never => {
		throw new Error("row " + slug + " outcome " + verb + " did not hold: " + detail);
	};
	for (const needle of (spec.contains ?? []) as string[]) {
		if (!text.includes(needle)) bad("contains", "the rendered text has no " + JSON.stringify(needle));
	}
	for (const selector of (spec.selector_present ?? []) as string[]) {
		if (container.querySelector(selector) === null) bad("selector_present", "no element matches " + selector);
	}
	for (const selector of (spec.selector_absent ?? []) as string[]) {
		if (container.querySelector(selector) !== null) bad("selector_absent", selector + " is present");
	}
}

async function renderRow(row: Vector): Promise<void> {
	const restore = applyEnv(row.env);
	try {
		await withStubs(row, async () => {
			if (!globalThis.document) {
				const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
				await GlobalRegistrator.register({ url: "http://localhost" });
			}
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
			const React = await import("react");
			const { createRoot } = await import("react-dom/client");
			const act = (React as unknown as { act: (run: () => Promise<void>) => Promise<void> }).act;
			const Component = await loadExport(row.module, row.export);
			if (typeof Component !== "function") throw new Error("export " + row.export + " in " + row.module + " is not a component — a render row needs a callable component export");
			const decoded = await Promise.all(((row.args ?? []) as unknown[]).map(decodeValue));
			const props = decoded.length === 0 ? {} : buildElements(React, decoded[0], row.slug);
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			let caught: unknown;
			try {
				await act(async () => {
					root.render(React.createElement(Component, props as Record<string, unknown>));
				});
			} catch (err) {
				caught = err;
			}
			if (row.expect_error !== undefined) {
				if (caught === undefined) throw new Error("row " + row.slug + " expected the render to throw " + JSON.stringify(row.expect_error) + ", and it returned a tree");
				const message = caught instanceof Error ? caught.message : String(caught);
				if (!message.includes(String(row.expect_error))) throw new Error("row " + row.slug + " outcome expect_error did not hold: the render threw " + JSON.stringify(message));
				await act(async () => { root.unmount(); });
				host.remove();
				return;
			}
			if (caught !== undefined) throw caught instanceof Error ? caught : new Error(String(caught));
			const clickSelectors = ((row.expect as Record<string, unknown>).render as Record<string, unknown>).click;
			if (clickSelectors !== undefined) {
				for (const selector of (Array.isArray(clickSelectors) ? clickSelectors : [clickSelectors]) as string[]) {
					const target = host.querySelector(selector);
					if (target === null) throw new Error("row " + row.slug + " outcome click did not hold: no element matches " + selector);
					await act(async () => {
						target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
					});
				}
			}
			assertRenderSpec(row.slug, host, (row.expect as Record<string, unknown>).render);
			await act(async () => { root.unmount(); });
			host.remove();
		});

	} finally {
		restore();
	}
}
async function hookRow(row: Vector): Promise<void> {
	const restore = applyEnv(row.env);
	try {
		await withStubs(row, async () => {
			if (!globalThis.document) {
				const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
				await GlobalRegistrator.register({ url: "http://localhost" });
			}
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
			const React = await import("react");
			const { createRoot } = await import("react-dom/client");
			const act = (React as unknown as { act: (run: () => Promise<void>) => Promise<void> }).act;
			const hook = await loadExport(row.module, row.export);
			if (typeof hook !== "function") throw new Error("export " + row.export + " in " + row.module + " is not a hook — a hook row mounts the export and drives what it returns");
			const decoded = await Promise.all(((row.args ?? []) as unknown[]).map(decodeValue));
			if (decoded.length > 1) throw new Error("a hook row takes at most one arg — the options object the hook is mounted with");
			const options = decoded.length === 0 ? {} : decoded[0];
			let latest: unknown = undefined;
			function Probe(): null {
				latest = (hook as (o: unknown) => unknown)(options);
				return null;
			}
			const root = createRoot(document.createElement("div"));
			await act(async () => { root.render(React.createElement(Probe)); });
			const spec = ((row.expect as Record<string, unknown>).hook) as Record<string, unknown>;
			for (const [j, entry] of ((spec.act ?? []) as Record<string, unknown>[]).entries()) {
				const returned = latest as Record<string, unknown> | null | undefined;
				const fn = returned === null || returned === undefined ? undefined : returned[entry.call as string];
				if (typeof fn !== "function") throw new Error("row " + row.slug + " outcome hook did not hold: the hook returned no callable " + entry.call + " at act[" + j + "] — a callback the row drives is one the hook itself returns");
				const actArgs = await Promise.all(((entry.args ?? []) as unknown[]).map(decodeValue));
				await act(async () => { (fn as (...a: unknown[]) => unknown)(...actArgs); });
			}
			assertHookResult(row.slug, latest, spec.result as Record<string, unknown>);
			await act(async () => { root.unmount(); });
		});
	} finally {
		restore();
	}
}
function runFsFlow(row: Vector): Promise<void> {
	return (async () => {
		const workspace = await mkdtemp(join(tmpdir(), "contract-"));
		const before = process.env.SCALA_WORKSPACE_ROOT;
		process.env.SCALA_WORKSPACE_ROOT = workspace;
		try {
			await withStubs(row, async () => {
				for (const step of row.steps as Vector[]) {
					const [modPath, stepExport] = stepTarget(row, step);
					const args = await Promise.all((step.args ?? []).map(decodeValue));
					if (isExportShape(step.expect)) {
						assertStructural(row.slug, await loadExport(modPath, stepExport), (step.expect as Record<string, unknown>)[EXPORT_SHAPE]);
					} else if (step.expect_error !== undefined) {
						await expect(callExport(modPath, stepExport, args)).rejects.toThrow(step.expect_error);
					} else {
						if (isStructural(step.expect) && (step.expect as Record<string, unknown>)[ARG_SHAPE] !== undefined) argTarget(row.slug, step.expect as Record<string, unknown>, args);
						const value = await callExport(modPath, stepExport, args);
						if (isStructural(step.expect)) {
							if ((step.expect as Record<string, unknown>)[ARG_SHAPE] !== undefined) assertArgShape(row.slug, step.expect as Record<string, unknown>, args);
							else assertStructural(row.slug, value, step.expect);
						}
						else if (isTextSpec(step.expect)) assertText(row.slug, value, step.expect as Record<string, unknown>);
						else if (step.expect_void === true) expect(value).toBeUndefined();
					else expect(value).toEqual(step.expect);
					}
				}
			});
	} finally {
			if (before === undefined) delete process.env.SCALA_WORKSPACE_ROOT;
			else process.env.SCALA_WORKSPACE_ROOT = before;
			await rm(workspace, { recursive: true, force: true });
	}
	})();
}


// ------------------------------------------------------------- fixtures
// Stubs, recorded outcomes and seeded state are three different facts. This
// runner carries the FIRST two; seeded state is the db_flow arm's business.
//
// The CLOSED outcome vocabulary. A key outside it is refused by name: a
// predicate the runner does not understand is a row whose case silently
// stopped being asserted, which is the one failure this wave cannot have.
const OUTCOME_VERBS = ["count", "equals", "contains", "absent", "sql_contains", "sql_absent", "binds"] as const;

type Stub = Vector & { module: string; export: string; record?: string; returns?: unknown; error?: unknown; when_sql_contains?: string };
type Call = { args: unknown[] };

// A stub's `module` is the SUBJECT'S OWN IMPORT SPECIFIER — what the
// subject wrote in its import line — so it resolves against the subject
// file's directory, not the package root.
function stubPath(row: Vector, stub: Stub): string {
	return resolve(dirname(resolve(ROOT, String(row.module))), String(stub.module));
}

// A stub answers with the DATA the row declared, decoded SYNCHRONOUSLY: a
// subject may call its dependency without awaiting it, and an async stub
// hands that subject a Promise whose members are undefined — the row then
// asserts against a value no row declared. Awaiting a plain value is the
// value, so an async subject is unaffected. A stub return is a VALUE
// position: null is null here, the opposite of an ARG position.
function decodeStubReturn(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(decodeStubReturn);
	// {"$date": "<ISO>"} is the instant a subject calls a METHOD on —
	// toISOString, getTime — and a decoded STRING has none of them
	// (measured: user-prefs reads row.updated_at.toISOString(), and a
	// stub that answered the string gave it "toISOString is not a
	// function"). The same arm the arg decoder has, so a date reaches
	// a subject as a Date whether it came in as an argument or as a
	// stub's answer. A value that is not an instant is refused by name
	// rather than becoming Invalid Date.
	if (typeof value === "object" && value !== null && "$date" in value) {
		const stubbed = new Date(String((value as { $date: unknown }).$date));
		if (Number.isNaN(stubbed.getTime())) throw new Error("$date " + JSON.stringify((value as { $date: unknown }).$date) + " is not an instant this runtime can read");
		return stubbed;
	}
	if (typeof value === "object" && value !== null) {
		if ("$fn" in value) {
			// A stubbed export may RETURN a contract whose members are FUNCTIONS —
			// an injected page client (getBrandColors: () => Record) is the measured
			// shape. {"$fn": {"returns": X}} decodes to the same SYNC zero-arg thunk
			// the arg side builds; a function member declared as plain data would be
			// called by the subject and fail as "not a function" against a stub that
			// answered with an inert object.
			const spec = (value as { $fn: { returns?: unknown; throws?: unknown; returns_by_call?: unknown[] } }).$fn;
			// THE SEQUENCE. A stateful fake is the standard shape for a
			// readback contract — a write whose success is only real if the row
			// read back carries it — and a static return cannot say it: the same
			// member answers differently before and after the write.
			// {"returns_by_call": [A, B, …]} answers the Nth call with the Nth
			// declared answer, and a call past the end is REFUSED naming the
			// count: an answer past the list is one no row declared, and
			// guessing it is how a readback assertion stops meaning anything.
			if (Array.isArray(spec.returns_by_call)) {
				const answers = (spec.returns_by_call as unknown[]).map(decodeStubReturn);
				let served = 0;
				return () => {
					if (served >= answers.length) throw new Error("a stubbed member was called " + (served + 1) + " times but declares " + answers.length + " answers — the next one is a value no row declared");
					return answers[served++];
				};
			}
			// A STUBBED CLIENT RECORDS TOO. `records` is honoured here as it is
			// on the arg side, into the same per-row map, so an injected
			// collaborator declared as a module stub asserts through the same
			// outcomes vocabulary as one declared as an argument (measured
			// 2026-10-05: a stubbed member wrote `records` and the row's
			// count read zero — the write happened, the recording did not).
			if (spec.returns !== undefined) {
				const answer = decodeStubReturn(spec.returns);
				if (spec.records === undefined) return () => answer;
				declareRecorder(String(spec.records));
				return (...callArgs: unknown[]) => {
					recordCall(String(spec.records), callArgs);
					return answer;
				};
			}
			if (spec.throws !== undefined) {
				const raised = decodeStubReturn(spec.throws);
				return () => {
					throw raised;
				};
			}
			throw new Error("a fixture stub return declares $fn with neither returns nor throws — a function whose behaviour is undeclared is a case the runner cannot run");
		}
		if ("$error" in value) {
			throw new Error("a fixture stub return declares $error — a stub's failure is the stub-level error key; a return is what the call answers with");
		}
		const walked: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			walked[key] = decodeStubReturn(inner);
		}
		return walked;
	}
	return value;
}

// Every stub sharing an export forms ONE group: a Db stub answers per SQL
// shape, and the first shape whose needle the call's SQL satisfies wins. A
// call matching no declared shape REFUSES — guessing an answer no row
// declared is how a test asserts something that was never true.
function stubReturn(slug: string, group: Stub[], call: Call): unknown {
	const sql = typeof call.args[0] === "string" ? (call.args[0] as string) : "";
	for (const stub of group) {
		if (stub.when_sql_contains !== undefined && !sql.includes(String(stub.when_sql_contains))) continue;
		if (stub.error !== undefined) throw stub.error;
		return stub.returns;
	}
	if (group.every((stub) => stub.when_sql_contains !== undefined)) {
		throw new Error(
			`row ${slug} is malformed: no fixture stub matches the SQL shape ${JSON.stringify(sql.slice(0, 120))} — ` +
			"declared shapes: " + group.map((stub) => JSON.stringify(stub.when_sql_contains)).join(", "));
	}
	return group[0].returns;
}

// Applies the row's stubs, runs the body, ASSERTS the recording on the
// success path, then RESTORES every mocked module with the exports it had —
// a stub that outlived its row would answer the rows after it with a value
// they never declared. Outcomes are NOT asserted when the body itself
// threw: the row already failed for a more specific reason than any
// predicate over a call that may never have completed.
async function withStubs<T>(row: Vector, fn: () => Promise<T>): Promise<T> {
	const stubs = (row.fixtures?.stubs ?? []) as Stub[];
	// A row with no stubs still asserts its outcomes: a recording declared
	// on an INJECTED arg ($fn.records) has no stub, and before 1.4.0 the
	// outcomes of such a row were never checked — a case that stopped
	// asserting without saying so.
	if (stubs.length === 0) {
		const result = await fn();
		returnOutcome(row.slug, ACTIVE_RECORDERS, row.outcomes as Record<string, Vector[]> | undefined);
		return result;
	}
	const slug = row.slug;
	for (const stub of stubs) {
		if (stub.record !== undefined) declareRecorder(String(stub.record));
	}
	const paths = [...new Set(stubs.map((stub) => stubPath(row, stub)))];
	for (const path of paths) {
		const group = stubs.filter((stub) => stubPath(row, stub) === path);
		const exported: Record<string, unknown> = {};
		for (const name of new Set(group.map((stub) => String(stub.export)))) {
			const arms = group.filter((stub) => String(stub.export) === name);
			exported[name] = (...args: unknown[]) => {
				const call: Call = { args };
				for (const arm of arms) {
					if (arm.record !== undefined) (ACTIVE_RECORDERS[arm.record] ??= []).push(call);
				}
				return decodeStubReturn(stubReturn(slug, arms, call));
			};
		}
		mock.module(path, () => exported);
	}
	const result = await fn();
	returnOutcome(slug, ACTIVE_RECORDERS, row.outcomes as Record<string, Vector[]> | undefined);
	return result;
}

// A STUB LIVES FOR THE WHOLE PROCESS — measured on bun 1.4.2, not assumed:
// mock.module(path, () => original) leaves the mock installed,
// mock.restore() does not restore module mocks, and the live namespace is
// readonly, so there is no in-process teardown that undoes a module mock.
// The honest consequence: a row with fixtures runs in its OWN PROCESS (
// runIsolated below), so no stub can answer a row that never declared it.
function hasFixtures(row: Vector): boolean {
	return Array.isArray(row.fixtures?.stubs) && (row.fixtures!.stubs as Stub[]).length > 0;
}

// A HOISTED ROW RUNS IN ITS OWN PROCESS, for the same reason a stubbed one
// does: a configure step changes MODULE state the runner cannot undo (no
// teardown restores whatever configureX was handed), so a hoist left in the
// parent would answer rows that never declared it — measured in the
// wild as the reason the configured-primitive contract could not be a
// row: poolSizeFor's own defaults are the claim, and the injected-size
// rows would silently become the defaults for every row after them.
function hasHoist(row: Vector): boolean {
	return Array.isArray(row.hoist) && (row.hoist as unknown[]).length > 0;
}
// A factory row's contract IS its members: the claim axis runs against the
// call, and the steps below assert what the RETURNED handle does. A row
// that declares steps and no claim is well-formed — naming that here
// keeps the "asserts nothing" refusal from refusing a row that does.
function hasThen(row: Vector): boolean {
	return Array.isArray(row.then) && (row.then as unknown[]).length > 0;
}
// then_call_each is a CLAIM in its own right for the same reason then is:
// the value a list-of-predicates subject returns is not comparable to
// anything a row can write, and what the row means is what those
// predicates DO. Counting it is what lets such a row exist at all.
function hasCallEach(row: Vector): boolean {
	return Array.isArray(row.then_call_each) && (row.then_call_each as unknown[]).length > 0;
}
// THE CALL-EACH ARM. Some subjects return a LIST OF PREDICATES rather than
// a value: where-translate answers [WherePredicate], each one a function
// the CALLER invokes against its own accessor, and what the row cares
// about is which accessor calls each predicate makes. No arm could say
// that — then calls members of one returned object, and a returned array
// is a value whose elements are functions, so every existing spelling
// compared the array to a literal and learned nothing (measured: 18 cases
// in foundation-db-ts's where-translate.test.ts, none writable).
//
// `then_call_each` builds the ACCESSOR — a recording proxy over an empty
// object — calls every returned predicate with it, and asserts the calls
// in order as [{field, method, args}]. The row states the shape the
// subject is supposed to emit, so a translation that emitted eq where
// the row says in fails by naming both. A predicate that is not callable,
// or a return that is not an array, is refused BY NAME.
interface Recorded { field: string; method: string; args: unknown[] }
function recordingAccessor(sink: Recorded[]): unknown {
	return new Proxy({}, {
		get(_target, field) {
			return new Proxy({}, {
				get(_t2, method) {
					return (...args: unknown[]) => {
						const recorded: Recorded = { field: String(field), method: String(method), args };
						sink.push(recorded);
						return recorded;
						};
				},
			});
		},
	});
}
async function callReturned(slug: string, returned: unknown, spec: Vector): Promise<void> {
	if (typeof returned !== "function") throw new Error("row " + slug + " declares then_return but the call returned " + (returned === null ? "null" : typeof returned) + ", not a callable to invoke — a factory is the only subject this arm reaches");
	const args = await Promise.all(((spec.args ?? []) as unknown[]).map((a) => decodeValue(a)));
	try {
		const answer = await (returned as (...a: unknown[]) => unknown)(...args);
		if (spec.expect_error !== undefined) throw new Error("row " + slug + " declares expect_error but the returned callable RESOLVED with " + JSON.stringify(answer) + " — an error row must be answered by a rejection");
		expect(answer).toEqual(spec.expect);
	} catch (err) {
		if (spec.expect_error === undefined) throw err;
		if (!String((err as Error).message).includes(String(spec.expect_error))) throw new Error("row " + slug + " then_return rejected with " + JSON.stringify(String((err as Error).message)) + ", which does not carry " + JSON.stringify(String(spec.expect_error)));
	}
}
async function callEach(slug: string, returned: unknown, want: unknown): Promise<void> {
	if (!Array.isArray(returned)) throw new Error("row " + slug + " declares then_call_each but the call returned " + (returned === null ? "null" : typeof returned) + ", not a list of predicates to call");
	const declared = want as Recorded[];
	const recorded: Recorded[] = [];
	const accessor = recordingAccessor(recorded);
	for (const [index, predicate] of (returned as unknown[]).entries()) {
		if (typeof predicate !== "function") throw new Error("row " + slug + " then_call_each element " + index + " is " + (predicate === null ? "null" : typeof predicate) + " — a list element nobody can call is not a predicate");
		await (predicate as (acc: unknown) => unknown)(accessor);
	}
	// Key-ORDER INSENSITIVE. The subject builds {field, method, args} in
	// its own order and the row spells them in the reader's, so a
	// JSON.stringify comparison reports a difference between two records
	// that are the same record (measured: the first row to use this arm
	// emitted {"field","method","args"} against a row declaring
	// {"args","field","method"}). Each side is normalised to a fixed
	// member order, so the comparison is about the VALUES.
	const shape = (calls: Recorded[]): unknown => calls.map((call) => ({ field: call.field, method: call.method, args: call.args }));
	if (JSON.stringify(shape(recorded)) !== JSON.stringify(declared.map((call) => ({ field: String((call as Recorded).field), method: String((call as Recorded).method), args: (call as Recorded).args })))) {
		throw new Error("row " + slug + " then_call_each did not hold:\n  the subject emitted " + JSON.stringify(shape(recorded)) + "\n  the row declared  " + JSON.stringify(declared));
	}
}

// Re-runs THIS FILE under `bun test` selecting only this row, in a fresh
// process. The child's exit code is the verdict and its output is the
// evidence, so a refusal inside the child (an undeclared SQL shape, an
// outcome verb the runner does not know) surfaces verbatim in the parent.
function runIsolated(row: Vector): void {
	const child = spawnSync("bun", ["test", SELF, "--test-name-pattern", row.slug], {
		cwd: ROOT,
		env: { ...process.env, SCALA_CONTRACT_ROW: row.slug },
		encoding: "utf8",
	});
	if (child.status !== 0) {
		const evidence = (child.stderr || child.stdout || "").trimEnd().split("\n").slice(-14).join("\n");
		throw new Error(`row ${row.slug} failed in its isolated run:\n${evidence}`);
	}
}

// ONE predicate vocabulary over what the stubs recorded: count is the number
// of calls; equals is the whole recording deep-equal to the declared value;
// contains/absent are substrings of it; sql_contains/sql_absent are over the
// recorded SQL; binds is the binds argument of the selected call (the one
// sql_contains names, or the first call when no SQL predicate is declared),
// deep-equal to the declared array. Every declared verb is checked — one the
// runner does not know is a refusal, never a skip.
function returnOutcome(slug: string, recorders: Record<string, Call[]>, outcomes?: Record<string, Vector[]>): void {
	if (outcomes === undefined) return;
	for (const [recorder, predicates] of Object.entries(outcomes)) {
		const calls = recorders[recorder] ?? [];
		for (const predicate of predicates) {
			for (const verb of Object.keys(predicate)) {
				if (!(OUTCOME_VERBS as readonly string[]).includes(verb)) {
					throw new Error(
						`row ${slug} is malformed: outcome ${recorder}.${verb} is not a declared verb ` +
						JSON.stringify(OUTCOME_VERBS) + " — a predicate this runner does not understand is a case it stopped asserting");
				}
			}
			const say = (verb: string): never => {
				throw new Error(`row ${slug} outcome ${recorder}.${verb} did not hold`);
			};
			if (predicate.count !== undefined && calls.length !== Number(predicate.count)) say("count");
			if (predicate.sql_absent !== undefined) {
				for (const call of calls) {
					if (typeof call.args[0] === "string" && (call.args[0] as string).includes(String(predicate.sql_absent))) say("sql_absent");
				}
			}
			const text = JSON.stringify(calls);
			if (predicate.contains !== undefined && !text.includes(String(predicate.contains))) say("contains");
			if (predicate.absent !== undefined && text.includes(String(predicate.absent))) say("absent");
			if (predicate.equals !== undefined && text !== JSON.stringify(predicate.equals)) say("equals");
			if (predicate.sql_contains !== undefined && !calls.some((call) => typeof call.args[0] === "string" && (call.args[0] as string).includes(String(predicate.sql_contains)))) say("sql_contains");
			if (predicate.binds !== undefined) {
				const selected = predicate.sql_contains === undefined
					? calls[0]
					: calls.find((call) => typeof call.args[0] === "string" && (call.args[0] as string).includes(String(predicate.sql_contains)));
				if (selected === undefined) say("binds");
				// A TAGGED-TEMPLATE CALL PASSES ITS VALUES AS REST ARGS, not as one
				// array: a recorded $queryRaw(strings, ...values) has the
				// TemplateStringsArray at index 0 and each interpolated value
				// after it. The array is identified by the `raw` property the
				// runtime's own tagged templates carry — a plain string array is
				// the driver's binds argument and must NOT be read as a template.
				const templateStringsAt = selected.args.findIndex((arg) => Array.isArray(arg) && "raw" in (arg as object));
				const binds = templateStringsAt >= 0 ? selected.args.slice(templateStringsAt + 1) : selected.args.find((arg) => Array.isArray(arg));
				if (JSON.stringify(binds) !== JSON.stringify(predicate.binds)) say("binds");
			}
		}
	}
}
function runRow(row: Vector): Promise<void> | void {
	// Refused BY NAME before any call: the failing `it` is the row's slug.
	assertWellFormed(row);
	// The recording is THIS row's, alone. Rows run in one process, so a
	// map that survived the previous row would answer a count with its
	// calls — measured 2026-10-05: a get row failed count:1 in the suite
	// and passed alone, reading the upsert row's call as its own.
	ACTIVE_RECORDERS = {};
	if (SELECTED === undefined && (hasFixtures(row) || hasHoist(row))) return runIsolated(row);
	if (isRenderRow(row.expect, row.args as unknown[] | undefined)) return renderRow(row);
	if (isHook(row.expect)) return hookRow(row);
	if (row.suite_type === "fs_flow") return runFsFlow(row);
	// A tagged-template subject is called through the template arm, which
	// builds the TemplateStringsArray the signature's first parameter
	// demands. args[] beside template is refused rather than half-read:
	// two ways to say the same call is a row whose intent is unreadable.
	if (row.template !== undefined && row.template !== null) {
		if (row.args !== undefined && row.args !== null) throw new Error("row " + row.slug + " declares both args and template — a tagged-template subject takes its statement as template, and two ways to say the same call is a row whose intent is unreadable");
		return expectCall(row, row.export, decodeTemplate(row.slug, row.template as Record<string, unknown>));
	}
	return expectCall(row, row.export, row.args ?? []);
}

describe("@teamscala/tool-executor function_call contracts", () => {
	for (const row of ROWS) {
		if (SELECTED !== undefined && row.slug !== SELECTED) continue;
		it(row.slug, async () => {
			await runRow(row);
		});
	}
});
