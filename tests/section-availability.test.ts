// "Available" has twice meant "the key exists" instead of "there is something
// in it" (PR 9: checkout, PR 13: card). The rule now lives in one helper,
// section() in src/lib/redact.ts. These tests fail if anything decides
// availability anywhere else, or if a section skips the helper.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildModelInput, section, type StallForModel } from "@/lib/redact";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

// Strips comments, and the one sanctioned block in redact.ts.
function code(path: string): string {
  let text = readFileSync(path, "utf8");
  if (path.endsWith(join("lib", "redact.ts"))) {
    const begin = text.indexOf("// availability:begin");
    const end = text.indexOf("// availability:end");
    assert.ok(begin >= 0 && end > begin, "redact.ts must keep the availability:begin/end markers around section()");
    text = text.slice(0, begin) + text.slice(end);
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("section availability is decided in one place", () => {
  it("no source file outside section() writes `available: true` or `available: false`", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("scripts")]) {
      const lines = code(file).split("\n");
      lines.forEach((line, i) => {
        if (/\bavailable\s*:\s*(true|false)\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `availability decided outside section():\n${offenders.join("\n")}`);
  });

  it("every section of the model input carries `available`, so none can skip the helper", () => {
    const input = buildModelInput(
      { gateway_response: "x", amount: 1, currency: "NGN", event_type: "transaction.abandoned", payload: {} },
      "x",
    ) as Record<string, unknown>;
    const objectKeys = Object.keys(input).filter((k) => input[k] !== null && typeof input[k] === "object");
    assert.ok(objectKeys.length >= 3);
    for (const k of objectKeys) {
      assert.ok("available" in (input[k] as object), `section "${k}" was built without section()`);
    }
  });
});

describe("section() rules", () => {
  const WHY = "gap";
  for (const [label, fields] of [
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["all-null fields", { a: null, b: null }],
    ["only an empty array", { steps: [] }],
    ["nulls and an empty array", { a: null, steps: [] }],
  ] as const) {
    it(`${label} is unavailable, with the reason`, () => {
      assert.deepEqual(section(fields as object | null | undefined, WHY), { available: false, why: WHY });
    });
  }

  for (const [label, fields] of [
    ["a string", { a: "visa" }],
    ["a zero", { attempts: 0 }],
    ["a false", { mobile: false }],
    ["a non-empty array", { steps: [{}] }],
  ] as const) {
    it(`${label} makes the section available`, () => {
      assert.equal(section(fields, WHY).available, true);
    });
  }
});

describe("every Paystack-backed section, sent empty, is a gap", () => {
  const base: StallForModel = { gateway_response: "The transaction was not completed", amount: 1, currency: "NGN", event_type: "transaction.abandoned", payload: {} };
  for (const [key, payload] of [
    ["card", { authorization: {} }],
    ["card", { authorization: { card_type: null, brand: null, bank: null, country_code: null } }],
    ["checkout", { log: {} }],
    ["checkout", { log: { time_spent: null, attempts: null, errors: null, mobile: null, history: [] } }],
  ] as const) {
    it(`${key} with ${JSON.stringify(payload)}`, () => {
      const input = buildModelInput({ ...base, payload }, base.gateway_response);
      assert.equal(input[key].available, false);
    });
  }
});
