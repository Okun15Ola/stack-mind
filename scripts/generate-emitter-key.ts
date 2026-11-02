// Generates an Ed25519 key pair for a behaviour-trail emitter (issue #12).
//
//   npm run emitter-key -- --merchant <id> --emitter <name> --env test|live
//   npm run emitter-key -- --rotate <oek_key_id>
//
// Run this on the EMITTER OWNER'S machine, not on Opada. It:
//   - writes the PRIVATE key (PKCS#8 PEM) to ./<key_id>.private.pem, mode 600.
//     Put it in the emitter's secret store, then delete the file. It is never
//     sent to Opada, and Opada can't recover it.
//   - prints the PUBLIC key and the SQL that registers it, for Okunola to run
//     in the Supabase SQL editor.
// With --rotate, it prints SQL that adds the new public key as the second
// active key. Once the emitter signs with the new key, promote it to
// public_key_1 and clear public_key_2.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { merchant: { type: "string" }, emitter: { type: "string" }, env: { type: "string" }, rotate: { type: "string" } },
});

function fail(message: string): never {
  console.error(`emitter-key: ${message}`);
  process.exit(1);
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = (n: number) => Array.from(randomBytes(n), (b) => BASE62[b % 62]).join("");

let keyId: string;
if (args.rotate) {
  if (!/^oek_(test|live)_[A-Za-z0-9]{16,64}$/.test(args.rotate)) fail("--rotate needs an existing oek_ key id");
  keyId = args.rotate;
} else {
  if (!args.merchant || !/^[a-z0-9_-]{2,64}$/.test(args.merchant)) fail("--merchant <id> is required (lowercase letters, digits, _ or -)");
  if (!args.emitter || !/^[a-z0-9_-]{2,64}$/.test(args.emitter)) fail("--emitter <name> is required (e.g. shopcart)");
  if (args.env !== "test" && args.env !== "live") fail("--env must be test or live");
  keyId = `oek_${args.env}_${randomId(24)}`;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const file = `${args.rotate ? `${keyId}.rotated` : keyId}.private.pem`;
writeFileSync(file, privatePem, { mode: 0o600 });

console.log(`key id:      ${keyId}`);
console.log(`public key:  ${rawPublic}`);
console.log(`private key: written to ./${file} (mode 600). Move it into the emitter's secret store, then delete the file.`);
console.log("");
console.log("SQL for Okunola to run in the Supabase SQL editor:");
if (args.rotate) {
  console.log(`update public.emitter_keys set public_key_2 = ${sqlText(rawPublic)} where key_id = ${sqlText(keyId)};`);
} else {
  console.log(
    `insert into public.emitter_keys (key_id, merchant_id, emitter_name, environment, public_key_1) values (${[keyId, args.merchant!, args.emitter!, args.env!, rawPublic].map(sqlText).join(", ")});`,
  );
}
