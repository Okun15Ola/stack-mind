import Anthropic from "@anthropic-ai/sdk";
import { REASONS } from "@/lib/reasons";
import type { ModelInput } from "@/lib/redact";

// A model that declined to answer. Recorded so a refusal is never silent.
export type ModelRefusal = { model: string; category: string | null };

export type ModelClassification = {
  output: unknown;
  // The model that actually produced `output`: after a refusal fallback, the
  // fallback model, never the one originally requested.
  model: string;
  // Every model that refused before `model` answered, in order. Empty when the
  // first model answered.
  refusals: ModelRefusal[];
};

// Thrown when every model in the chain refused. Carries the refusals (model ids
// and categories only, no input) so the caller can record them.
export class ModelRefusedError extends Error {
  constructor(readonly refusals: ModelRefusal[]) {
    super(`model refused (${refusals.map((r) => `${r.model}: ${r.category ?? "no category"}`).join("; ")})`);
    this.name = "ModelRefusedError";
  }
}

// The one seam between the classifier and any LLM provider. A provider receives
// input that has already passed the PII gate, and returns its raw output, the
// id of the model that produced it, and any refusals on the way. Validation
// happens in the classifier, so a provider cannot write an unchecked reason to
// the database.
export interface DiagnosisModel {
  classify(input: ModelInput): Promise<ModelClassification>;
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

// Cheap by default: the model only sees cases the rules can't decide, and
// those are short classification calls. Set DIAGNOSIS_MODEL=claude-opus-5-5
// for the frontier model.
export const DEFAULT_DIAGNOSIS_MODEL = "claude-haiku-5-5";

// Models that support Anthropic's server-side refusal fallback. Haiku does not:
// a declined Haiku request stays declined, so refusals there are retried
// client-side on REFUSAL_FALLBACK_MODEL instead.
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
export const REFUSAL_FALLBACK_MODEL = "claude-sonnet-5-5";

type MessagesClient = Pick<Anthropic, "beta">;

export class AnthropicDiagnosisModel implements DiagnosisModel {
  constructor(
    private readonly model: string = DEFAULT_DIAGNOSIS_MODEL,
    private readonly client: MessagesClient = new Anthropic(),
  ) {}

  async classify(input: ModelInput): Promise<ModelClassification> {
    const refusals: ModelRefusal[] = [];
    let response = await this.request(this.model, input);
    refusals.push(...serverFallbackRefusals(response));

    if (response.stop_reason === "refusal" && !SERVER_FALLBACK_MODELS.has(this.model)) {
      refusals.push({ model: servedBy(response), category: response.stop_details?.category ?? null });
      response = await this.request(REFUSAL_FALLBACK_MODEL, input);
      refusals.push(...serverFallbackRefusals(response));
    }
    if (response.stop_reason === "refusal") {
      refusals.push({ model: servedBy(response), category: response.stop_details?.category ?? null });
      throw new ModelRefusedError(refusals);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("model output truncated at max_tokens");
    }

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      // JSON.parse errors quote the offending text; never surface it.
      throw new Error("model output is not valid JSON");
    }
    return { output, model: `anthropic:${servedBy(response)}`, refusals };
  }

  private request(model: string, input: ModelInput) {
    const serverFallback = SERVER_FALLBACK_MODELS.has(model);
    return this.client.beta.messages.create({
      model,
      // Thinking counts toward this; leave room beyond the short JSON answer.
      max_tokens: 4096,
      // Re-runs a safety-classifier refusal on Anthropic's recommended fallback model.
      ...(serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: {
        effort: model.startsWith("claude-haiku") ? "low" : "medium",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Diagnose this stalled payment:\n\n${JSON.stringify(input, null, 2)}` }],
    });
  }
}

type MessagesResponse = Awaited<ReturnType<MessagesClient["beta"]["messages"]["create"]>>;

// The model that produced this response, as the API reports it. With a
// server-side fallback the top-level `model` is the fallback model. Never
// falls back to the requested id: an audit row must not name a model that
// did not answer.
function servedBy(response: MessagesResponse): string {
  const model = "model" in response ? response.model : undefined;
  if (typeof model !== "string" || !model.trim()) throw new Error("model response does not name the model that produced it");
  return model;
}

// Models that declined inside one request before a server-side fallback
// answered. Each switch point is a `fallback` content block.
function serverFallbackRefusals(response: MessagesResponse): ModelRefusal[] {
  if (!("content" in response) || !Array.isArray(response.content)) return [];
  return response.content.flatMap((block) =>
    block.type === "fallback" ? [{ model: block.from.model, category: block.trigger?.category ?? null }] : [],
  );
}

// Two variables, read in this order:
//
//   DIAGNOSIS_MODEL_PROVIDER  whether a model is used at all, and whose.
//     unset, "" or "none"  -> no model. Rules only; a stall the rules can't
//                             classify stays undiagnosed. DIAGNOSIS_MODEL is
//                             ignored (with a warning) and no API key is read.
//     "anthropic"          -> Anthropic, model chosen by DIAGNOSIS_MODEL.
//     anything else        -> throws.
//
//   DIAGNOSIS_MODEL  which Anthropic model, only when the provider is
//     "anthropic". Unset -> DEFAULT_DIAGNOSIS_MODEL. Must be a claude-* id.
export function getDiagnosisModel(): DiagnosisModel | null {
  const provider = (process.env.DIAGNOSIS_MODEL_PROVIDER ?? "").trim().toLowerCase();
  const model = (process.env.DIAGNOSIS_MODEL ?? "").trim();
  if (provider === "" || provider === "none") {
    if (model) console.warn("[diagnosis-model] DIAGNOSIS_MODEL is set but DIAGNOSIS_MODEL_PROVIDER is not; ignoring it, rules only");
    return null;
  }
  if (provider === "anthropic") {
    if (model && !/^claude-[a-z0-9-]+$/.test(model)) {
      throw new Error(`DIAGNOSIS_MODEL "${model}" is not an Anthropic model id`);
    }
    return new AnthropicDiagnosisModel(model || DEFAULT_DIAGNOSIS_MODEL);
  }
  throw new Error(`unknown DIAGNOSIS_MODEL_PROVIDER "${provider}"`);
}
