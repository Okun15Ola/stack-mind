// The source-scanning guards, as plain functions over (path, text) pairs, so
// they can be run both on the real tree and on negative fixtures
// (tests/guard-fixtures.test.ts). A guard with no test proving it bites is
// not a guard.
//
// The guards scan RAW source text. They deliberately do not strip comments:
// an earlier comment-stripper treated the "//" in "https://" as a comment and
// hid the rest of the line, so a direct Paystack call slipped through. With no
// stripper there is nothing to get wrong; a comment that trips a guard should
// just be reworded.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SourceFile = { path: string; text: string };

export function readTree(...dirs: string[]): SourceFile[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [path] : [];
    });
  return dirs.flatMap(walk).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

// Removes the text between `// <name>:begin` and `// <name>:end`. Returns null
// if the markers are missing or out of order, which is itself a violation.
function withoutBlock(text: string, name: string): string | null {
  const begin = text.indexOf(`// ${name}:begin`);
  const end = text.indexOf(`// ${name}:end`);
  if (begin < 0 || end <= begin) return null;
  return text.slice(0, begin) + text.slice(end);
}

function linesMatching(file: SourceFile, text: string, re: RegExp): string[] {
  return text.split("\n").flatMap((line, i) => (re.test(line) ? [`${file.path}:${i + 1}: ${line.trim()}`] : []));
}

// --- Paystack: every call goes through paystackRequest() -----------------------

export const PAYSTACK_FILE = join("src", "lib", "paystack.ts");

export function paystackGuardViolations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const isClient = file.path === PAYSTACK_FILE;
    let scanned = file.text;
    if (isClient) {
      const outside = withoutBlock(file.text, "paystack-http");
      if (outside === null) {
        out.push(`${file.path}: paystack-http:begin/end markers missing`);
        continue;
      }
      scanned = outside;
      const fetches = (file.text.match(/\bfetch\s*\(/g) ?? []).length;
      if (fetches !== 1) out.push(`${file.path}: expected exactly one fetch(, found ${fetches}`);
      out.push(...linesMatching(file, outside, /\bfetch\s*\(/).map((l) => `fetch outside paystackRequest(): ${l}`));
    }
    out.push(...linesMatching(file, scanned, /paystack\.co\b/).map((l) => `Paystack API host outside paystackRequest(): ${l}`));
    if (!isClient) {
      out.push(
        ...linesMatching(file, file.text, /process\.env(\.PAYSTACK_SECRET_KEY\b|\[\s*["'`]PAYSTACK_SECRET_KEY)/).map(
          (l) => `PAYSTACK_SECRET_KEY read outside paystack.ts: ${l}`,
        ),
      );
    }
  }
  return out;
}

export const EXPECTED_ALLOWLIST = ["GET list transactions", "GET verify transaction"];

export function allowlistViolations(entries: readonly { method: string; name: string }[]): string[] {
  const out: string[] = [];
  const got = entries.map((e) => `${e.method} ${e.name}`);
  if (JSON.stringify(got) !== JSON.stringify(EXPECTED_ALLOWLIST)) {
    out.push(`allowlist changed: expected ${JSON.stringify(EXPECTED_ALLOWLIST)}, got ${JSON.stringify(got)}`);
  }
  for (const e of entries) if (e.method !== "GET") out.push(`non-GET allowlist entry: ${e.method} ${e.name}`);
  return out;
}

// --- Section availability: decided only in section() ---------------------------

export const REDACT_FILE = join("src", "lib", "redact.ts");

export function availabilityGuardViolations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    let scanned = file.text;
    if (file.path === REDACT_FILE) {
      const outside = withoutBlock(file.text, "availability");
      if (outside === null) {
        out.push(`${file.path}: availability:begin/end markers missing`);
        continue;
      }
      scanned = outside;
    }
    out.push(...linesMatching(file, scanned, /\bavailable\s*:\s*(true|false)\b/).map((l) => `availability decided outside section(): ${l}`));
  }
  return out;
}

// Every object-valued field of a built model input must carry `available`.
export function sectionsMissingAvailability(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v) && !("available" in (v as object)))
    .map(([k]) => `section "${k}" was built without section()`);
}

// --- Live Paystack key: only the named read-only entrypoints -------------------

export const EXPECTED_LIVE_ENTRYPOINTS = ["poller", "diagnose-stall", "compare-models", "export-test-set"];

export function liveEntrypointViolations(list: readonly string[]): string[] {
  const out: string[] = [];
  if (JSON.stringify([...list]) !== JSON.stringify(EXPECTED_LIVE_ENTRYPOINTS)) {
    out.push(`live-key entrypoints changed: expected ${JSON.stringify(EXPECTED_LIVE_ENTRYPOINTS)}, got ${JSON.stringify(list)}`);
  }
  if (list.includes("webhook")) out.push("the webhook handler must never accept a live key");
  return out;
}

// Which entrypoint each file is. Only these files may call paystackKeyFor(),
// each only with its own name, as a string literal.
export const ENTRYPOINT_FILES: Record<string, string> = {
  [join("src", "app", "api", "cron", "poll-paystack", "route.ts")]: "poller",
  [join("src", "app", "api", "webhooks", "paystack", "route.ts")]: "webhook",
  [join("scripts", "diagnose-stall.ts")]: "diagnose-stall",
  [join("scripts", "compare-models.ts")]: "compare-models",
  [join("scripts", "export-test-set.mts")]: "export-test-set",
};

export function entrypointNamingViolations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const own = ENTRYPOINT_FILES[file.path];
    const calls = file.text
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bpaystackKeyFor\s*\(/.test(line) && !/function\s+paystackKeyFor\s*\(/.test(line));
    for (const { line, n } of calls) {
      const m = line.match(/\bpaystackKeyFor\s*\(\s*["'`]([a-z-]+)["'`]\s*[,)]/);
      if (!own) out.push(`${file.path}:${n}: paystackKeyFor() called outside a named entrypoint`);
      else if (!m) out.push(`${file.path}:${n}: paystackKeyFor() must be called with a string literal`);
      else if (m[1] !== own) out.push(`${file.path}:${n}: ${file.path} is "${own}" but asks for the key as "${m[1]}"`);
    }
    if (own && calls.length === 0) out.push(`${file.path}: entrypoint "${own}" never calls paystackKeyFor("${own}")`);
  }
  return out;
}
