// The PII gate is the only thing keeping buyer data out of model prompts.
// These tests run in CI on every push and pull request (.github/workflows/ci.yml).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PiiLeakError, assertNoPii, buildModelInput, knownIdentifiers, scrubText, type PiiKind } from "@/lib/redact";

// Asserts the gate refuses `text`, with the expected kind, and that the error
// message never contains the value or any long run of its digits.
function refuses(text: string, kind: PiiKind, known: string[] = []) {
  let caught: unknown;
  try {
    assertNoPii({ checkout: { steps: [{ message: `note: ${text} end` }] } }, known);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof PiiLeakError, `gate passed ${JSON.stringify(text)}`);
  assert.equal(caught.kind, kind, `wrong kind for ${JSON.stringify(text)}`);
  assertSafeMessage(caught.message, [text, ...known]);
}

function assertSafeMessage(message: string, values: string[]) {
  for (const v of values) {
    assert.ok(!message.includes(v), "error message contains the leaked value");
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 4) assert.ok(!message.replace(/\D/g, "").includes(digits), "error message contains the leaked digits");
  }
}

describe("PII gate: Nigerian phone numbers", () => {
  const phones = [
    "08031234567",
    "0803 123 4567",
    "0803-123-4567",
    "0803.123.4567",
    "0803 1234 567",
    "(0803) 123 4567",
    "+2348031234567",
    "+234 803 123 4567",
    "+234-803-123-4567",
    "+234 (0) 803 123 4567",
    "+234 0803 123 4567",
    "2348031234567",
    "234 803 123 4567",
    "234-803-123-4567",
    "002348031234567",
    "8031234567",
    "803 123 4567",
    "07031234567",
    "0813 123 4567",
    "0905-123-4567",
    "+234 913 123 4567",
    "0803 123 4567", // non-breaking spaces
    "0803–123–4567", // en dashes
    "0803​1234567", // zero-width space
    "０８０３１２３４５６７", // full-width digits
  ];
  for (const p of phones) {
    it(`refuses ${JSON.stringify(p)}`, () => refuses(p, "phone"));
    it(`scrubs ${JSON.stringify(p)}`, () => {
      const out = scrubText(`call ${p} now`);
      assert.ok(!/\d{4}/.test(out.replace(/\D+/g, "")), `scrubText left digits: ${out}`);
    });
  }
});

describe("PII gate: other patterns", () => {
  const cases: [string, PiiKind][] = [
    ["buyer@example.com", "email"],
    ["Ada.Obi+shop@mail.example.ng", "email"],
    ["buyer＠example.com", "email"], // full-width @
    ["4084 0840 8408 4081", "card"],
    ["4084084084084081", "card"],
    ["4084-0840-8408-4081", "card"],
    ["5060 9905 8000 0217 499", "card"], // 19-digit Verve
    ["102.89.1.20", "ip"],
    ["2001:db8:85a3:0:0:8a2e:370:7334", "ip"],
    ["2001:db8::1", "ip"],
    ["fe80::1ff:fe23:4567:890a", "ip"],
    ["CUS_abc123xyz", "code"],
    ["AUTH_zzz999", "code"],
    ["PLN_gx2wn530m0i3w3m", "code"],
    ["SUB_vsyqdmlzble3uii", "code"],
    ["RCP_1i2k27vk4suemug", "code"],
    ["account 0123456789", "number"],
    ["4084 0840 8408 4082", "number"], // fails Luhn, still a long number
  ];
  for (const [text, kind] of cases) it(`refuses ${JSON.stringify(text)} as ${kind}`, () => refuses(text, kind));
});

describe("PII gate: the stall's own identifiers", () => {
  const stall = {
    id: "5b0c6f1e-6a7e-4b55-9f39-0d2f4d1b9a11",
    customer_identifier: "buyer@example.com",
    payload: {
      id: 4099260516,
      reference: "T169809891137085",
      ip_address: "102.89.1.20",
      customer: { id: 408932014, email: "buyer@example.com", phone: "+2348031234567", first_name: "Adaeze", last_name: "Okonkwo", customer_code: "CUS_abc123xyz" },
      authorization: { authorization_code: "AUTH_zzz999", bin: "408408", last4: "4081", account_name: "ADAEZE OKONKWO", signature: "SIG_ZfGLsRAWHr6ze8Fuuw6u" },
      metadata: { full_name: "Adaeze Okonkwo" },
    },
  };
  const known = knownIdentifiers(stall);

  it("collects the stall id, reference, transaction id and customer details", () => {
    for (const v of [stall.id, "T169809891137085", "4099260516", "408932014", "Adaeze", "Okonkwo", "Adaeze Okonkwo", "408408", "4081", "SIG_ZfGLsRAWHr6ze8Fuuw6u"]) {
      assert.ok(known.includes(v), `missing ${v}`);
    }
  });

  for (const text of [
    "Adaeze opened checkout",
    "ADAEZE OKONKWO",
    "ref T169809891137085",
    "stall 5b0c6f1e-6a7e-4b55-9f39-0d2f4d1b9a11",
    "card ending 4081",
    "bin 408408",
    "SIG_ZfGLsRAWHr6ze8Fuuw6u",
  ]) {
    it(`refuses ${JSON.stringify(text)}`, () => refuses(text, "identifier", known));
  }

  it("refuses a known id that arrives as a number", () => {
    assert.throws(() => assertNoPii({ checkout: { attempts: 408932014 } }, known), (e: unknown) => e instanceof PiiLeakError && e.kind === "identifier");
  });

  it("refuses a known numeric id written with separators", () => {
    assert.throws(() => assertNoPii({ m: "id 408-932-014" }, known), PiiLeakError);
  });

  it("refuses a known identifier in an object key, without naming the key", () => {
    try {
      assertNoPii({ checkout: { Adaeze: true } }, known);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof PiiLeakError);
      assertSafeMessage(e.message, known);
    }
  });

  it("built input for this stall passes the gate", () => {
    const row = { gateway_response: "The transaction was not completed", amount: 250000, currency: "NGN", event_type: "transaction.abandoned", payload: stall.payload };
    assert.doesNotThrow(() => assertNoPii(buildModelInput(row, row.gateway_response), known));
  });
});

describe("PII gate: fails closed", () => {
  const uninspectable: [string, unknown][] = [
    ["a Date", { at: new Date() }],
    ["a Map", { m: new Map([["email", "a@b.co"]]) }],
    ["a class instance", { x: new (class Box { v = "a@b.co"; })() }],
    ["a bigint", { n: BigInt(1) }],
    ["a function", { f: () => "a@b.co" }],
    ["a symbol key", { [Symbol("s")]: "a@b.co" }],
    ["NaN", { n: Number.NaN }],
    ["a cycle", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
  ];
  for (const [label, input] of uninspectable) {
    it(`refuses ${label}`, () => {
      assert.throws(() => assertNoPii(input, []), (e: unknown) => e instanceof PiiLeakError && e.kind === "uninspectable");
    });
  }

  it("refuses when known identifiers are not a string array", () => {
    assert.throws(() => assertNoPii({}, null as unknown as string[]), PiiLeakError);
    assert.throws(() => assertNoPii({}, [42] as unknown as string[]), PiiLeakError);
  });

  it("checks object keys, not only values", () => {
    assert.throws(() => assertNoPii({ "buyer@example.com": 1 }, []), (e: unknown) => e instanceof PiiLeakError && e.kind === "email");
  });

  it("names the field path in the error, never the value", () => {
    try {
      assertNoPii({ checkout: { steps: [{ message: "x" }, { message: "ring 0803 123 4567" }] } }, []);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof PiiLeakError);
      assert.equal(e.path, "input.checkout.steps[1].message");
      assert.equal(e.name, "PiiLeakError");
      assertSafeMessage(e.message, ["0803 123 4567"]);
    }
  });

  it("passes ordinary non-identifying input", () => {
    assert.doesNotThrow(() =>
      assertNoPii(
        {
          gateway_response: "The transaction was not completed",
          amount_minor_units: 1500000000,
          currency: "NGN",
          checkout: { time_spent_seconds: 240, attempts: 0, steps: [{ type: "action", message: "Set payment method to: Card", at_second: 30 }] },
        },
        ["Adaeze"],
      ),
    );
  });
});
