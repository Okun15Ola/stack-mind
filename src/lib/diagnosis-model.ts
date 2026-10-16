import Anthropic from "@anthropic-ai/sdk";
import { REASONS } from "@/lib/reasons";
import type { ModelInput } from "@/lib/redact";

// The one seam between the classifier and any LLM provider. A provider receives
// input that has already passed the PII gate, and returns its raw output plus
// the id of the model that produced it. Validation happens in the classifier,
// so a provider cannot write an unchecked reason to the database.
export interface DiagnosisModel {
  classify(input: ModelInput): Promise<{ output: unknown; model: string }>;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", enum: [...REASONS] },
    confidence: { type: "number", description: "Probability from 0 to 1 that the reason is correct." },
    rationale: { type: "string", description: "One to three sentences citing the facts used." },
  },
  required: ["reason", "confidence", "rationale"],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You diagnose why a Paystack payment did not complete. You receive redacted transaction facts only, with no customer identity.

Choose exactly one reason:
- NO_FUNDS_NOW: the payment method works but lacks funds, or hit a spending limit, right now.
- CARD_FAILING: the issuer or Paystack declined the card or account, or the card itself has a problem (declined, do not honor, expired, restricted, wrong PIN, fraud block).
- PROVIDER_DOWN: the bank, issuer, switch or Paystack failed technically (inoperative, malfunction, unavailable).
- NO_TRUST: the customer reached the payment step and backed out without any technical error, for example stopping at card entry or OTP.
- UNANSWERED_QUESTION: signs the customer paused to find information (price, delivery, terms) and left without attempting payment, such as a long dwell with no attempt.
- FORGOT: the checkout was opened but never really attempted, and nothing points to a decline, an outage or hesitation.

gateway_response is the primary signal. If it describes a decline, the reason is CARD_FAILING even when there is no checkout activity. Use checkout activity only to separate NO_TRUST, UNANSWERED_QUESTION and FORGOT when gateway_response shows no decline, funds problem or outage.

confidence is your probability that the reason is right. Go below 0.5 when the evidence is thin, which it often is for the last three reasons. The rationale cites the facts you used and never speculates about who the customer is.`;

export class AnthropicDiagnosisModel implements DiagnosisModel {
  constructor(
    private readonly client: Anthropic = new Anthropic(),
    private readonly model = "claude-opus-5-5",
  ) {}

  async classify(input: ModelInput): Promise<{ output: unknown; model: string }> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4096,
      // Re-runs a safety-classifier refusal on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Diagnose this stalled payment:\n\n${JSON.stringify(input, null, 2)}` }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`model refused (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("model output truncated at max_tokens");
    }

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { output: JSON.parse(text), model: `anthropic:${response.model}` };
  }
}

// DIAGNOSIS_MODEL_PROVIDER selects the provider. Unset or "none" means no
// model: only gateway_response rules run, and anything they can't classify is
// left undiagnosed rather than guessed.
export function getDiagnosisModel(): DiagnosisModel | null {
  const provider = (process.env.DIAGNOSIS_MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "" || provider === "none") return null;
  if (provider === "anthropic") return new AnthropicDiagnosisModel();
  throw new Error(`unknown DIAGNOSIS_MODEL_PROVIDER "${provider}"`);
}
