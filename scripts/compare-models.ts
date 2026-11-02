// Runs real stalls through diagnosis models side by side, to choose the
// default on quality. Saves no diagnosis.
//
//   npm run compare-models -- [--model <provider>:<model> ...] <reference> [<reference> ...]
//
// With no --model, it compares every model it has a key for: the default Groq
// model if GROQ_API_KEY is set, and claude-haiku-5-5 and claude-opus-5-5 if
// ANTHROPIC_API_KEY is set. Examples:
//   npm run compare-models -- 9v85euqujlld90l yi8ijvdw7mjns54 T169809891137085
//   npm run compare-models -- --model groq:openai/gpt-oss-120b --model groq:llama-3.3-70b-versatile T169809891137085
//
// Each stall is re-verified first (AGENTS.md: no diagnosis without it), which
// updates stalls.verified_at, or resolves the stall if the customer has paid.
// Nothing else is written. Every stall goes to both models, including ones the
// gateway_response rules would classify on their own, so the models can be
// compared on all of them. Model input is the same allowlisted, PII-gated view
// that diagnosis uses. Output is a Markdown table: reason, confidence, the
// model that actually answered, refusals, and the (scrubbed) rationale.
// Needs SUPABASE_*, a Paystack key (see paystackKeyFor), and GROQ_API_KEY and/or
// ANTHROPIC_API_KEY for the models being compared.

import { validateClassification, type StallForDiagnosis } from "@/lib/diagnose";
import { DEFAULT_GROQ_MODEL, ModelRefusedError, ModelUnparseableError, createDiagnosisModel, type DiagnosisModel } from "@/lib/diagnosis-model";
import { evidenceGaps } from "@/lib/evidence";
import { classifyGatewayResponse } from "@/lib/gateway-rules";
import { INSUFFICIENT_EVIDENCE } from "@/lib/reasons";
import { assertNoPii, buildModelInput, knownIdentifiers } from "@/lib/redact";
import { paystackKeyFor } from "@/lib/paystack";
import { reverifyStall } from "@/lib/reverify";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Candidate = { label: string; model: DiagnosisModel };

function defaultCandidates(): string[] {
  const specs: string[] = [];
  if (process.env.GROQ_API_KEY) specs.push(`groq:${DEFAULT_GROQ_MODEL}`);
  if (process.env.ANTHROPIC_API_KEY) specs.push("anthropic:claude-haiku-5-5", "anthropic:claude-opus-5-5");
  return specs;
}

function candidate(spec: string): Candidate {
  const at = spec.indexOf(":");
  if (at <= 0 || at === spec.length - 1) throw new Error(`--model must be <provider>:<model>, got "${spec}"`);
  const provider = spec.slice(0, at).toLowerCase();
  const model = spec.slice(at + 1);
  return { label: `${provider}:${model}`, model: createDiagnosisModel(provider, model) };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

async function compare(reference: string, candidates: Candidate[], secretKey: string): Promise<string[]> {
  const { data: row, error } = await supabaseAdmin()
    .from("stalls")
    .select("id, status, gateway_response, amount, currency, event_type, customer_identifier, payload")
    .eq("paystack_reference", reference)
    .maybeSingle<StallForDiagnosis>();
  if (error) throw new Error(`load ${reference}: ${error.message}`);
  if (!row) return [`| ${reference} | not found | | | | | | |`];

  const check = await reverifyStall(row.id, secretKey);
  if (check.outcome === "resolved") return [`| ${reference} | resolved (customer paid), not diagnosed | | | | | | |`];

  const gatewayResponse = check.stall.gatewayResponse ?? row.gateway_response;
  const rules = classifyGatewayResponse(gatewayResponse);
  const rulesCell = rules ? `${rules.reason} ${rules.confidence}` : "none";
  const input = buildModelInput(row, gatewayResponse);
  assertNoPii(input, knownIdentifiers(row));

  const lines: string[] = [];
  for (const { label, model } of candidates) {
    const prefix = `| ${reference} | ${check.stall.paystackStatus} | ${rulesCell} | ${label}`;
    try {
      const r = await model.classify(input);
      const c = validateClassification(r.output);
      const refusals = r.refusals.map((x) => `${x.model} (${x.category ?? "no category"})`).join("; ") || "none";
      const needed = c.reason === INSUFFICIENT_EVIDENCE ? ` (needs: ${evidenceGaps(input).join(", ") || "none listed"})` : "";
      lines.push(`${prefix} | **${c.reason}** ${c.confidence}${needed} | ${r.model} | ${refusals} | ${cell(c.rationale)} |`);
    } catch (err) {
      const what =
        err instanceof ModelRefusedError
          ? `refused by all: ${err.message}`
          : err instanceof ModelUnparseableError
            ? `unparseable: ${err.message}`
            : `error: ${err instanceof Error ? err.message : "unknown"}`;
      lines.push(`${prefix} | ${cell(what)} | | | |`);
    }
  }
  return lines;
}

async function main(): Promise<number> {
  // Refuses to start on a disallowed key setup, before anything else runs.
  const secretKey = paystackKeyFor("compare-models");
  const args = process.argv.slice(2);
  const specs: string[] = [];
  const references: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model") specs.push(args[++i] ?? "");
    else references.push(args[i]);
  }
  if (references.length === 0) {
    console.error("usage: npm run compare-models -- [--model <provider>:<model> ...] <reference> [<reference> ...]");
    return 1;
  }
  const chosen = specs.length ? specs : defaultCandidates();
  if (chosen.length === 0) {
    console.error("no models to compare: set GROQ_API_KEY and/or ANTHROPIC_API_KEY, or pass --model");
    return 1;
  }
  const candidates = chosen.map(candidate);
  const out = [
    "| Reference | paystack_status | Rules | Requested | Reason, confidence | Answered by | Refusals | Rationale |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const reference of references) out.push(...(await compare(reference, candidates, secretKey)));
  console.log(out.join("\n"));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
