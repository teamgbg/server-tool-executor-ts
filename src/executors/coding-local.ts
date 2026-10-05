/**
 * @system tool-executor
 * @status handwritten
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { spawnSync } from "@teamscala/os/spawn/sync";
import { workspaceRoot } from "@teamscala/os/host-paths";

/** The bus command names the coding rows carry; each executes here. */
export const CODING_COMMANDS = new Set(["workspace_file", "codemod", "scala_tools_exec"]);

export function isCodingCommand(command: string): boolean {
	return CODING_COMMANDS.has(command);
}

/** Default line ceiling for `read`, matching what a model can usefully hold. */
const DEFAULT_READ_LIMIT = 2000;
/** Ceiling on `list` output so an unscoped call cannot return the whole tree. */
const DEFAULT_LIST_MAX = 500;
/** Ceiling on `pattern_search` output. */
const DEFAULT_SEARCH_MAX = 200;
/** Wall-clock budget for a scala-tools verb run from the engine. */
const DEFAULT_TOOLS_BUDGET_MS = 120_000;
/** The ignore set every file walk shares. */
const WALK_EXCLUDES = ["-g", "!node_modules", "-g", "!.git", "-g", "!dist", "-g", "!.bun"];

export type CodingResult = { ok: true; result: unknown } | { ok: false; error: string };

const ok = (result: unknown): CodingResult => ({ ok: true, result });
const fail = (error: string): CodingResult => ({ ok: false, error });

/** Resolve a workspace-relative path to absolute (absolute passes through). */
export function toAbs(root: string, s: string): string {
	return isAbsolute(s) ? s : `${root}/${s}`;
}

/**
 * Lexically normalise `candidate` against `root` and return it ONLY when the
 * result stays inside `root`. `..` is resolved by popping, never by touching
 * the filesystem, so a path that escapes is rejected whether or not it
 * exists; a component that would pop past the root makes the whole path
 * uncontained rather than clamping to root.
 */
export function containedAbs(root: string, candidate: string): string | null {
	const joined = toAbs(root, candidate);
	const out: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return null;
			out.pop();
			continue;
		}
		out.push(part);
	}
	const abs = `/${out.join("/")}`;
	const rootNorm = root.replace(/\/+$/, "");
	return abs === rootNorm || abs.startsWith(`${rootNorm}/`) ? abs : null;
}

/** The slice of `content` a `read` returns: 1-based `offset`, `limit` lines. */
export function sliceLines(content: string, offset: number, limit: number): { text: string; total: number; truncated: boolean } {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) lines.pop();
	const total = lines.length;
	const start = Math.min(Math.max(offset - 1, 0), total);
	const end = Math.min(start + limit, total);
	return { text: lines.slice(start, end).join("\n"), total, truncated: end < total };
}

/** Replace exactly one occurrence of `oldString`, or refuse with the count. */
export function applyExactEdit(content: string, oldString: string, newString: string): { ok: true; updated: string } | { ok: false; error: string } {
	if (oldString.length === 0) return { ok: false, error: "edit requires a non-empty 'old_string'" };
	const count = content.split(oldString).length - 1;
	if (count === 0) return { ok: false, error: "edit refused: 'old_string' does not occur in the file" };
	if (count > 1) {
		return { ok: false, error: `edit refused: 'old_string' occurs ${count} times — include enough surrounding context to name exactly one site` };
	}
	return { ok: true, updated: content.replace(oldString, () => newString) };
}

/**
 * The workspace this process may act on: the declared root when this process
 * can write it. `null` names the refusal — the caller reports it, never routes
 * elsewhere.
 */
export function ownedWorkspace(): { root: string } | { refused: string } {
	let root: string;
	try {
		root = workspaceRoot();
	} catch (error) {
		return { refused: `no workspace root is declared for this process (${(error as Error).message}); the coding layer runs only in the engine of the lane that holds the repositories` };
	}
	try {
		accessSync(root, constants.W_OK);
	} catch {
		return { refused: `this process cannot write ${root}; the coding layer runs only in the engine of the lane that holds the repositories, never from another lane or a cloud caller` };
	}
	return { root };
}

function requiredStr(p: Record<string, unknown>, key: string): string | null {
	const v = p[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function strArray(p: Record<string, unknown>, key: string): string[] {
	const v = p[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function relativeTo(root: string, abs: string): string {
	const prefix = `${root}/`;
	return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** Write bytes even when the file is held read-only (a derived file), restoring the mode. */
function writeThroughMode(abs: string, content: string): void {
	const existed = existsSync(abs);
	const mode = existed ? statSync(abs).mode & 0o777 : null;
	if (existed && mode !== null && (mode & 0o200) === 0) {
		chmodSync(abs, mode | 0o200);
		writeFileSync(abs, content);
		chmodSync(abs, mode);
		return;
	}
	writeFileSync(abs, content);
}

function fileRead(root: string, p: Record<string, unknown>): CodingResult {
	const path = requiredStr(p, "path");
	if (!path) return fail("read requires 'path'");
	const abs = containedAbs(root, path);
	if (!abs) return fail(`read refused: '${path}' resolves outside the workspace root`);
	const offset = Math.max(Number(p.offset ?? 1) || 1, 1);
	const limit = Number(p.limit ?? DEFAULT_READ_LIMIT) || DEFAULT_READ_LIMIT;
	let content: string;
	try {
		content = readFileSync(abs, "utf8");
	} catch (error) {
		return fail(`read ${path} failed: ${(error as Error).message}`);
	}
	const { text, total, truncated } = sliceLines(content, offset, limit);
	return ok({ path: relativeTo(root, abs), content: text, lineCount: total, offset, truncated });
}

function fileWrite(root: string, p: Record<string, unknown>): CodingResult {
	const path = requiredStr(p, "path");
	if (!path) return fail("write requires 'path'");
	const content = typeof p.content === "string" ? p.content : null;
	if (content === null) return fail("write requires 'content'");
	const abs = containedAbs(root, path);
	if (!abs) return fail(`write refused: '${path}' resolves outside the workspace root`);
	try {
		mkdirSync(dirname(abs), { recursive: true });
		writeThroughMode(abs, content);
	} catch (error) {
		return fail(`write ${path} failed: ${(error as Error).message}`);
	}
	let back: string;
	try {
		back = readFileSync(abs, "utf8");
	} catch (error) {
		return fail(`write ${path}: readback failed: ${(error as Error).message}`);
	}
	if (back !== content) return fail(`write ${path}: readback disagrees — ${back.length} bytes on disk, ${content.length} written`);
	return ok({ path: relativeTo(root, abs), bytes: back.length, verified: true });
}

function fileEdit(root: string, p: Record<string, unknown>): CodingResult {
	const path = requiredStr(p, "path");
	if (!path) return fail("edit requires 'path'");
	const oldString = typeof p.old_string === "string" ? p.old_string : null;
	const newString = typeof p.new_string === "string" ? p.new_string : null;
	if (oldString === null) return fail("edit requires 'old_string'");
	if (newString === null) return fail("edit requires 'new_string'");
	const abs = containedAbs(root, path);
	if (!abs) return fail(`edit refused: '${path}' resolves outside the workspace root`);
	let content: string;
	try {
		content = readFileSync(abs, "utf8");
	} catch (error) {
		return fail(`edit ${path}: cannot read: ${(error as Error).message}`);
	}
	const edited = applyExactEdit(content, oldString, newString);
	if (!edited.ok) return fail(`${edited.error} (${path})`);
	try {
		writeThroughMode(abs, edited.updated);
	} catch (error) {
		return fail(`edit ${path} failed: ${(error as Error).message}`);
	}
	const back = readFileSync(abs, "utf8");
	if (back !== edited.updated) return fail(`edit ${path}: readback disagrees with what was written`);
	return ok({ path: relativeTo(root, abs), bytes: back.length, replaced: 1, verified: true });
}

function rg(root: string, args: string[], name: string): { ok: true; stdout: string } | { ok: false; error: string } {
	const run = spawnSync({ name, command: ["rg", ...args], cwd: root, timeoutMs: 60_000 });
	if (run.timedOut) return { ok: false, error: "ripgrep timed out" };
	if (run.exitCode === 2) return { ok: false, error: `ripgrep failed: ${run.stderr.trim()}` };
	return { ok: true, stdout: run.stdout };
}

function fileList(root: string, p: Record<string, unknown>): CodingResult {
	const max = Number(p.maxResults ?? DEFAULT_LIST_MAX) || DEFAULT_LIST_MAX;
	const scopeDirs: string[] = [];
	for (const s of strArray(p, "scope")) {
		const abs = containedAbs(root, s);
		if (!abs) return fail(`list refused: scope '${s}' resolves outside the workspace root`);
		scopeDirs.push(abs);
	}
	if (scopeDirs.length === 0) scopeDirs.push(root);
	const args = ["--files", ...WALK_EXCLUDES];
	const glob = requiredStr(p, "glob");
	if (glob) args.push("-g", glob);
	args.push(...scopeDirs);
	const run = rg(root, args, "coding-layer:list_files");
	if (!run.ok) return fail(run.error);
	const all = run.stdout.split("\n").filter((l) => l.length > 0);
	const files = all.slice(0, max).map((f) => relativeTo(root, f));
	return ok({ fileCount: files.length, truncated: all.length > max, files });
}

function patternSearch(root: string, p: Record<string, unknown>): CodingResult {
	const pattern = requiredStr(p, "pattern");
	if (!pattern) return fail("pattern_search requires 'pattern'");
	const max = Number(p.maxResults ?? DEFAULT_SEARCH_MAX) || DEFAULT_SEARCH_MAX;
	const scope = strArray(p, "scope");
	const scopeDirs = scope.length === 0 ? [root] : scope.map((s) => toAbs(root, s));
	const args = ["-n", "--no-heading", "--color", "never", ...WALK_EXCLUDES, "-g", "!*.lock"];
	const glob = requiredStr(p, "glob");
	if (glob) args.push("-g", glob);
	args.push(pattern, ...scopeDirs);
	const run = rg(root, args, "coding-layer:code_search");
	if (!run.ok) return fail(run.error);
	const all = run.stdout.split("\n").filter((l) => l.length > 0);
	const matches = all.slice(0, max).map((line) => {
		const m = /^(.*?):(\d+):(.*)$/.exec(line);
		return m ? { file: relativeTo(root, m[1]), line: Number(m[2]), text: m[3] } : { file: relativeTo(root, line), line: 0, text: "" };
	});
	return ok({ op: "pattern_search", matchCount: matches.length, truncated: all.length > max, matches });
}

function patternReplace(root: string, p: Record<string, unknown>): CodingResult {
	const scope = strArray(p, "scope");
	if (scope.length === 0) return fail("pattern_replace requires 'scope'");
	const pattern = requiredStr(p, "pattern");
	if (!pattern) return fail("pattern_replace requires 'pattern'");
	const replacement = typeof p.replacement === "string" ? p.replacement : null;
	if (replacement === null) return fail("pattern_replace requires 'replacement'");
	const dryRun = p.dryRun === true;
	const include = requiredStr(p, "include") ?? ".+\\.(tsx|ts|jsx|js)$";
	let re: RegExp;
	let includeRe: RegExp;
	try {
		re = new RegExp(pattern, "g");
	} catch (error) {
		return fail(`invalid pattern: ${(error as Error).message}`);
	}
	try {
		includeRe = new RegExp(include);
	} catch (error) {
		return fail(`invalid include: ${(error as Error).message}`);
	}
	const changed: Array<{ file: string }> = [];
	for (const dir of scope) {
		const abs = containedAbs(root, dir);
		if (!abs) return fail(`pattern_replace refused: scope '${dir}' resolves outside the workspace root`);
		const listing = rg(root, ["--files", ...WALK_EXCLUDES, abs], "coding-layer:code_edit");
		if (!listing.ok) return fail(listing.error);
		for (const file of listing.stdout.split("\n").filter((l) => l.length > 0 && includeRe.test(l))) {
			let content: string;
			try {
				content = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			re.lastIndex = 0;
			if (!re.test(content)) continue;
			const updated = content.replace(re, replacement);
			if (updated === content) continue;
			changed.push({ file: relativeTo(root, file) });
			if (!dryRun) {
				try {
					writeThroughMode(file, updated);
				} catch (error) {
					return fail(`write ${file} failed: ${(error as Error).message}`);
				}
			}
		}
	}
	return ok({ op: "pattern_replace", dryRun, filesChanged: changed.length, files: changed });
}

function scalaToolsExec(root: string, p: Record<string, unknown>): CodingResult {
	const verb = requiredStr(p, "verb");
	if (!verb) return fail("scala_tools_exec requires 'verb'");
	const args = strArray(p, "args");
	const cwdRaw = requiredStr(p, "cwd") ?? root;
	const cwd = containedAbs(root, cwdRaw);
	if (!cwd) return fail(`scala_tools_exec refused: cwd '${cwdRaw}' resolves outside the workspace root`);
	const budget = Number(p.execution_budget_ms ?? DEFAULT_TOOLS_BUDGET_MS) || DEFAULT_TOOLS_BUDGET_MS;
	const run = spawnSync({ name: `coding-layer:scala-tools:${verb}`, command: ["scala-tools", verb, ...args], cwd, timeoutMs: budget });
	return ok({
		verb,
		args,
		cwd: relativeTo(root, cwd) || ".",
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		stdout: run.stdout,
		stderr: run.stderr,
		durationMs: run.durationMs,
	});
}

/**
 * Execute one coding command in this process. `command` is the row's
 * `executor_config.command`; `args` is the merged payload the row-bus path
 * used to forward. Returns the same `{ ok, result } | { ok: false, error }`
 * shape the bus invoker returned, so every caller reads it unchanged.
 */
export function executeCodingLocally(command: string, args: Record<string, unknown>): CodingResult {
	const owned = ownedWorkspace();
	if ("refused" in owned) return fail(`${command} refused: ${owned.refused}`);
	const { root } = owned;
	const op = typeof args.op === "string" ? args.op : "";
	switch (command) {
		case "workspace_file":
			switch (op) {
				case "read":
					return fileRead(root, args);
				case "write":
					return fileWrite(root, args);
				case "edit":
					return fileEdit(root, args);
				case "list":
					return fileList(root, args);
				default:
					return fail("workspace_file requires 'op' — one of read | write | edit | list");
			}
		case "codemod":
			switch (op) {
				case "pattern_search":
					return patternSearch(root, args);
				case "pattern_replace":
					return patternReplace(root, args);
				default:
					return fail("codemod requires 'op' — one of pattern_search | pattern_replace");
			}
		case "scala_tools_exec":
			return scalaToolsExec(root, args);
		default:
			return fail(`${command} is not a coding command`);
	}
}
