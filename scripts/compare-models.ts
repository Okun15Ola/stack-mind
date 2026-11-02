// Runs real stalls through two diagnosis models side by side, to choose the
// default on quality. Saves no diagnosis.
//
//   npm run compare-models -- <reference> [<reference> ...]
//
// Each stall is re-verified first (AGENTS.md: no diagnosis without it), which
// updates stalls.verified_at, or resolves the stall if the customer has paid.
// Nothing else is written. Every stall goes to both models, including ones the
// gateway_response rules would classify on their own, so the models can be
// compared on all of them. Model input is the same allowlisted, PII-gated view
// that diagnosis uses. Output is a Markdown table: reason, confidence, the
// model that actually answered, refusals, and the (scrubbed) rationale.
// Needs ANTHROPIC_API_KEY, SUPABASE_* and a test-mode PAYSTACK_SECRET_KEY.

import { validateClassification, type StallForDiagnosis } from "@/lib/diagnose";
import { AnthropicDiagnosisModel, ModelRefusedError } from "@/lib/diagnosis-model";
import { classifyGatewayResponse } from "@/lib/gateway-rules";
import { assertNoPii, buildModelInput, knownIdentifiers } from "@/lib/redact";
import { reverifyStall } from "@/lib/reverify";
import { supabaseAdmin } from "@/lib/supabase-admin";

const MODELS = ["claude-haiku-5-5", "claude-opus-5-5"] as const;

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

async function compare(reference: string): Promise<string[]> {
  const { data: row, error } = await supabaseAdmin()
    .from("stalls")
    .select("id, status, gateway_response, amount, currency, event_type, customer_identifier, payload")
    .eq("paystack_reference", reference)
    .maybeSingle<StallForDiagnosis>();
  if (error) throw new Error(`load ${reference}: ${error.message}`);
  if (!row) return [`| ${reference} | not found | | | | | | |`];

  const check = await reverifyStall(row.id);
  if (check.outcome === "resolved") return [`| ${reference} | resolved (customer paid), not diagnosed | | | | | | |`];

  const gatewayResponse = check.stall.gatewayResponse ?? row.gateway_response;
  const rules = classifyGatewayResponse(gatewayResponse);
  const rulesCell = rules ? `${rules.reason} ${rules.confidence}` : "none";
  const input = buildModelInput(row, gatewayResponse);
  assertNoPii(input, knownIdentifiers(row));

  const lines: string[] = [];
  for (const requested of MODELS) {
    const prefix = `| ${reference} | ${check.stall.paystackStatus} | ${rulesCell} | ${requested}`;
    try {
      const r = await new AnthropicDiagnosisModel(requested).classify(input);
      const c = validateClassification(r.output);
      const refusals = r.refusals.map((x) => `${x.model} (${x.category ?? "no category"})`).join("; ") || "none";
      lines.push(`${prefix} | **${c.reason}** ${c.confidence} | ${r.model} | ${refusals} | ${cell(c.rationale)} |`);
    } catch (err) {
      const what = err instanceof ModelRefusedError ? `refused by all: ${err.message}` : `error: ${err instanceof Error ? err.message : "unknown"}`;
      lines.push(`${prefix} | ${cell(what)} | | | |`);
    }
  }
  return lines;
}

async function main(): Promise<number> {
  const references = process.argv.slice(2);
  if (references.length === 0) {
    console.error("usage: npm run compare-models -- <reference> [<reference> ...]");
    return 1;
  }
  const out = [
    "| Reference | paystack_status | Rules | Requested | Reason, confidence | Answered by | Refusals | Rationale |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const reference of references) out.push(...(await compare(reference)));
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
