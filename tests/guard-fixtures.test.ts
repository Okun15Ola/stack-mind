// Negative fixtures: each one MUST make its guard fail. If a refactor of a
// guard stops it biting, these fail. (The first version of these guards had
// exactly that hole: a comment-stripper hid a URL-string bypass.)
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PAYSTACK_FILE,
  REDACT_FILE,
  ENTRYPOINT_FILES,
  allowlistViolations,
  availabilityGuardViolations,
  entrypointNamingViolations,
  liveEntrypointViolations,
  purgeCallViolations,
  firstHandTableViolations,
  provenanceVetoViolations,
  merchantGateViolations,
  DIAGNOSE_FILE,
  paystackGuardViolations,
  sectionsMissingAvailability,
  type SourceFile,
} from "./guards";

const script = (text: string): SourceFile => ({ path: join("scripts", "fixture.ts"), text });
const lib = (text: string): SourceFile => ({ path: join("src", "lib", "fixture.ts"), text });
const PAYSTACK_OK = `
// paystack-http:begin
const PAYSTACK_HOST = "api.paystack.co";
export async function paystackRequest() { return fetch(\`https://\${PAYSTACK_HOST}/transaction\`); }
// paystack-http:end
export function paystackKeyFor() { return process.env.PAYSTACK_SECRET_KEY; }
`;
const REDACT_OK = `
// availability:begin
export function section(f, why) { return f ? { available: true, ...f } : { available: false, why }; }
// availability:end
`;

function bites(violations: string[], label: string) {
  assert.ok(violations.length > 0, `guard did not fire on: ${label}`);
}

describe("Paystack guard: negative fixtures", () => {
  it("a well-formed client passes (so the fixtures below fail for the right reason)", () => {
    assert.deepEqual(paystackGuardViolations([{ path: PAYSTACK_FILE, text: PAYSTACK_OK }]), []);
  });

  const cases: [string, SourceFile[]][] = [
    ["fetch to api.paystack.co inside a URL string (the one that slipped)", [script(`export const x = () => fetch("https://api.paystack.co/refund", { method: "POST" });`)]],
    ["the host after a // inside a string", [script(`const u = "see //"; fetch("https://api.paystack.co/transfer");`)]],
    ["the host in a template string", [script("fetch(`https://api.paystack.co/charge`)")]],
    ["the host split into a variable", [lib(`const HOST = "api.paystack.co"; fetch("https://" + HOST + "/refund");`)]],
    ["a direct read of the key outside paystack.ts", [lib(`export const k = process.env.PAYSTACK_SECRET_KEY;`)]],
    ["a bracket read of the key outside paystack.ts", [script(`const k = process.env["PAYSTACK_SECRET_KEY"];`)]],
    ["a second fetch in paystack.ts", [{ path: PAYSTACK_FILE, text: PAYSTACK_OK + `\nexport const y = () => fetch("https://x.example");` }]],
    ["the host outside the block in paystack.ts", [{ path: PAYSTACK_FILE, text: PAYSTACK_OK + `\nconst H = "api.paystack.co";` }]],
    ["paystack.ts with its markers removed", [{ path: PAYSTACK_FILE, text: PAYSTACK_OK.replace("// paystack-http:begin", "") }]],
  ];
  for (const [label, files] of cases) it(label, () => bites(paystackGuardViolations(files), label));

  it("an added allowlist entry", () => {
    const base = [
      { method: "GET", name: "list transactions" },
      { method: "GET", name: "verify transaction" },
    ];
    assert.deepEqual(allowlistViolations(base), []);
    bites(allowlistViolations([...base, { method: "POST", name: "refund" }]), "POST refund added");
    bites(allowlistViolations([...base, { method: "GET", name: "balance" }]), "GET balance added");
    bites(allowlistViolations([{ method: "POST", name: "list transactions" }, base[1]]), "method changed to POST");
    bites(allowlistViolations(base.slice(1)), "entry removed");
  });
});

describe("section() guard: negative fixtures", () => {
  it("a well-formed redact.ts passes", () => {
    assert.deepEqual(availabilityGuardViolations([{ path: REDACT_FILE, text: REDACT_OK }]), []);
  });

  const cases: [string, SourceFile[]][] = [
    ["available: true after a URL on the same line (the stripper hole)", [lib(`export const bad = { url: "https://x.example", available: true };`)]],
    ["available: false in another file", [lib(`return { available: false, why: "gap" };`)]],
    ["available:true with no space", [script(`const s = {available:true};`)]],
    ["availability decided in redact.ts outside section()", [{ path: REDACT_FILE, text: REDACT_OK + `\nconst card = { available: true };` }]],
    ["redact.ts with its markers removed", [{ path: REDACT_FILE, text: REDACT_OK.replace("// availability:end", "") }]],
  ];
  for (const [label, files] of cases) it(label, () => bites(availabilityGuardViolations(files), label));

  it("a section built without section()", () => {
    assert.deepEqual(sectionsMissingAvailability({ gateway_response: "x", card: { available: false, why: "g" } }), []);
    bites(sectionsMissingAvailability({ gateway_response: "x", card: { type: "visa", bank: null } }), "card without available");
  });
});

describe("live-key guards: negative fixtures", () => {
  it("the entrypoint list: adding the webhook, adding a name, or removing one", () => {
    const base = ["poller", "diagnose-stall", "compare-models", "export-test-set"];
    assert.deepEqual(liveEntrypointViolations(base), []);
    bites(liveEntrypointViolations([...base, "webhook"]), "webhook added");
    bites(liveEntrypointViolations([...base, "send-reminders"]), "a new entrypoint added");
    bites(liveEntrypointViolations(base.slice(1)), "an entrypoint removed");
  });

  const file = (name: string, text: string): SourceFile => {
    const path = Object.keys(ENTRYPOINT_FILES).find((p) => ENTRYPOINT_FILES[p] === name)!;
    return { path, text };
  };

  it("a well-formed entrypoint passes", () => {
    assert.deepEqual(entrypointNamingViolations([file("webhook", `secretKey = paystackKeyFor("webhook");`)]), []);
  });

  const cases: [string, SourceFile[]][] = [
    ["the webhook asking for the key as the poller", [file("webhook", `secretKey = paystackKeyFor("poller");`)]],
    ["a script asking under another script's name", [file("diagnose-stall", `const k = paystackKeyFor("export-test-set");`)]],
    ["a library file asking for the key", [lib(`const k = paystackKeyFor("poller");`)]],
    ["a non-literal entrypoint name", [file("compare-models", `const k = paystackKeyFor(name);`)]],
    ["an entrypoint that never asks for its key", [file("poller", `const result = await pollPaystack(secretKey);`)]],
  ];
  for (const [label, files] of cases) it(label, () => bites(entrypointNamingViolations(files), label));
});

describe("retention guard: negative fixtures", () => {
  it("a route that only checks retention passes", () => {
    assert.deepEqual(purgeCallViolations([lib(`await supabaseAdmin().rpc("behaviour_retention_status");`)]), []);
  });
  for (const [label, text] of [
    ["the cron route calling the purge over rpc", `await supabaseAdmin().rpc("purge_behaviour_events");`],
    ["raw SQL calling the purge", "await db.query(`select public.purge_behaviour_events()`);"],
  ] as const) {
    it(label, () => bites(purgeCallViolations([lib(text)]), label));
  }
});

describe("merchant gate guard: negative fixtures", () => {
  const diag = (body: string): SourceFile => ({ path: DIAGNOSE_FILE, text: `async function loadTrail(store, row) {\n${body}\n}` });
  it("checking before loading passes", () => {
    assert.deepEqual(merchantGateViolations([diag("assertSingleMerchant(await store.countMerchants());\nawait store.loadBehaviourEvents(refs, until);")]), []);
  });
  for (const [label, body] of [
    ["the check removed", "await store.loadBehaviourEvents(refs, until);"],
    ["the check moved after loading", "await store.loadBehaviourEvents(refs, until);\nassertSingleMerchant(await store.countMerchants());"],
  ] as const) {
    it(label, () => bites(merchantGateViolations([diag(body)]), label));
  }
  it("loadTrail renamed or gone", () => bites(merchantGateViolations([{ path: DIAGNOSE_FILE, text: "export {}" }]), "no loadTrail"));
});

describe("first-hand table guard: negative fixtures", () => {
  const types = ["paystack:gateway_response", "server_observed:question_asked"];
  const base = { CARD_FAILING: ["paystack:gateway_response"], UNANSWERED_QUESTION: ["server_observed:question_asked"], NO_TRUST: [], INSUFFICIENT_EVIDENCE: [] };
  it("the real shape passes", () => assert.deepEqual(firstHandTableViolations(types, base), []));
  for (const [label, t, table] of [
    ["a relayed event declared first-hand", [...types, "server_relayed:info_viewed"], base],
    ["a client event declared first-hand", [...types, "client:question_asked"], base],
    ["the provider-relayed checkout log declared first-hand", [...types, "paystack:checkout_log"], base],
    ["NO_TRUST counting a server_observed payment_started", [...types, "server_observed:payment_started"], { ...base, NO_TRUST: ["server_observed:payment_started"] }],
    ["a reason listing an undeclared type", types, { ...base, FORGOT: ["server_observed:checkout_left"] }],
    ["INSUFFICIENT_EVIDENCE given first-hand evidence", types, { ...base, INSUFFICIENT_EVIDENCE: ["paystack:gateway_response"] }],
  ] as const) {
    it(label, () => bites(firstHandTableViolations(t as readonly string[], table as Record<string, readonly string[]>), label));
  }
});

describe("guard fixtures: provenance is never a diagnosis veto", () => {
  it("the corrected wording passes", () =>
    assert.deepEqual(
      provenanceVetoViolations({
        fixture:
          "server_relayed and client events are browser assertions, and you may reach a reason on them. Calibrate confidence to how weak the evidence is. Provenance alone is never a reason to return INSUFFICIENT_EVIDENCE; return it only when the facts cannot separate the reasons.",
      }),
      [],
    ));
  for (const [label, text] of [
    // The exact wording that shipped in PR 21 and made the trail unable to establish any behavioural reason.
    ["the PR 21 prompt rule", "server_relayed and client events are browser assertions: they can support a reason but never establish one on their own. If only browser assertions would support a reason, return INSUFFICIENT_EVIDENCE."],
    ["the PR 21 source note", 'Events with any other provenance are browser assertions: they can support a reason but never establish one on their own.'],
    ["browser events may not establish", "Relayed events may not establish a reason."],
    ["IE unless server_observed", "Return INSUFFICIENT_EVIDENCE unless a server_observed event supports the reason."],
    ["only client evidence means IE", "If only client events point to a reason, answer INSUFFICIENT_EVIDENCE."],
  ] as const) {
    it(label, () => bites(provenanceVetoViolations({ fixture: text }), label));
  }
});
