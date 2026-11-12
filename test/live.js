// Live compatibility test against a running Procivis One Core instance.
//
// Usage:
//   node --env-file=.env test/live.js [--verbose]
//
// Environment (same names as pensioncredential-procivis uses):
//   PROCIVIS_API_BASE        e.g. https://procivis.development.findy.fi/api   (required)
//   PROCIVIS_API_TOKEN       static token, or the three below for client credentials
//   PROCIVIS_CLIENT_ID / PROCIVIS_CLIENT_SECRET / PROCIVIS_TOKEN_ENDPOINT
//   PROCIVIS_ORG_ID          organisation to create the test objects in (required)
//   PROCIVIS_KEEP=1          keep the created test objects (default: delete them)
//
// Every step has an expected outcome. "pass" means the call should work,
// "fail" marks a known incompatibility or bug that the call should hit, and
// "info" just reports what happened. The script exits non-zero if any step
// does not match its expectation. Output never contains the auth token.

import { Agent } from "../index.js";
import { upgradeCredentialSchema } from "../scripts/upgrade-schema.js";

const VERBOSE = process.argv.includes("--verbose");
const env = process.env;
const API_BASE = env.PROCIVIS_API_BASE;
const orgId = env.PROCIVIS_ORG_ID;
if (!API_BASE || !orgId) {
  console.error("Set PROCIVIS_API_BASE and PROCIVIS_ORG_ID");
  process.exit(2);
}
const auth = env.PROCIVIS_API_TOKEN
  ? { api_token: env.PROCIVIS_API_TOKEN }
  : {
      client_id: env.PROCIVIS_CLIENT_ID,
      client_secret: env.PROCIVIS_CLIENT_SECRET,
      token_endpoint: env.PROCIVIS_TOKEN_ENDPOINT,
    };
if (!auth.api_token && !(auth.client_id && auth.client_secret && auth.token_endpoint)) {
  console.error("Set PROCIVIS_API_TOKEN or PROCIVIS_CLIENT_ID/_SECRET/_TOKEN_ENDPOINT");
  process.exit(2);
}

// --- output and call recording ----------------------------------------------

const out = (s = "") => process.stdout.write(s + "\n");
const realConsole = { log: console.log, error: console.error, warn: console.warn };
// Mute the agent's own logging while it runs; failures are reported from the call log.
const mute = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
const unmute = () => Object.assign(console, realConsole);

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const resp = await realFetch(url, options);
  const text = await resp.clone().text().catch(() => "");
  const u = new URL(url);
  const isToken = auth.token_endpoint && String(url).startsWith(auth.token_endpoint);
  calls.push({
    method: options.method || "GET",
    path: u.pathname + (u.search ? "?" + u.searchParams.toString() : ""),
    status: resp.status,
    body: isToken ? "(token response hidden)" : text,
  });
  return resp;
};

const short = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

// --- step runner ---------------------------------------------------------------

const results = [];
async function step(name, expect, fn) {
  const from = calls.length;
  let ok = true, detail = "", value;
  mute();
  try {
    value = await fn();
    if (value === false) { ok = false; detail = "agent returned false (non-2xx)"; }
  } catch (e) {
    ok = false;
    detail = e.message;
  } finally {
    unmute();
  }
  const stepCalls = calls.slice(from);
  const failedCall = [...stepCalls].reverse().find((c) => c.status >= 400) || stepCalls.at(-1);
  if (!ok && failedCall) {
    detail = `${detail} | ${failedCall.method} ${failedCall.path} -> ${failedCall.status} ${short(failedCall.body)}`;
  } else if (ok && typeof value === "string") {
    detail = value;
  }
  const actual = ok ? "pass" : "fail";
  const matches = expect === "info" || expect === actual;
  results.push({ name, expect, actual, matches, detail });
  const mark = matches ? (expect === "info" ? "INFO" : "OK  ") : "XX  ";
  out(`${mark} [expect ${expect.padEnd(4)}, got ${actual}] ${name}${detail ? "\n       " + detail : ""}`);
  if (VERBOSE) for (const c of stepCalls) out(`       · ${c.method} ${c.path} -> ${c.status}`);
  return ok ? value : undefined;
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// --- test ------------------------------------------------------------------------

const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const NAME = `compat-test-${ts}`;
const created = { proofRequests: [], proofSchemas: [], credentials: [], credentialSchemas: [], dids: [] };

const agent = new Agent({ api_base: API_BASE });
await step("authenticate()", "pass", async () => {
  const before = JSON.stringify(auth);
  must(await agent.authenticate(auth), "authenticate() returned false");
  must(JSON.stringify(auth) === before, "authenticate() modified the auth object");
});
await step("the agent object does not expose credentials", "pass", async () => {
  const { inspect } = await import("node:util");
  const secrets = [auth.api_token, auth.client_secret].filter(Boolean);
  const shown = JSON.stringify(agent) + inspect(agent, { depth: 5 });
  must(!secrets.some((s) => shown.includes(s)), "a credential is visible on the agent object");
});

out("\n== System and config");
await step("getVersion()", "pass", async () => {
  const info = await agent.getVersion();
  must(info && typeof info === "object", `got ${short(JSON.stringify(info))}`);
  return `version: ${info.version ?? info.build?.version ?? short(JSON.stringify(info), 200)}`;
});
await step("health()", "pass", async () => {
  must((await agent.health()) === true, "health() did not return true");
});

const config = await step("getConfiguration()", "pass", () => agent.getConfiguration());
const cfgKeys = (section) => Object.keys(config?.[section] || {});
const pick = (section, preferred) => {
  const keys = cfgKeys(section);
  return preferred.find((k) => keys.includes(k)) || keys[0] || preferred[0];
};
const ISSUANCE = "OPENID4VCI_FINAL1";
const VERIFICATION = "OPENID4VP_FINAL1";
await step(`config has ${ISSUANCE} and ${VERIFICATION}`, "pass", () => {
  must(cfgKeys("issuanceProtocol").includes(ISSUANCE), `issuanceProtocol: ${cfgKeys("issuanceProtocol")}`);
  must(cfgKeys("verificationProtocol").includes(VERIFICATION), `verificationProtocol: ${cfgKeys("verificationProtocol")}`);
});
const FORMAT = pick("format", ["SD_JWT_VC"]);
const KEY_ALG = pick("keyAlgorithm", ["ECDSA", "EDDSA"]);
const KEY_STORAGE = pick("keyStorage", ["INTERNAL"]);
const DID_METHOD = pick("did", ["WEB", "KEY"]);
out(`       using format=${FORMAT} key=${KEY_ALG}/${KEY_STORAGE} did=${DID_METHOD}`);

out("\n== Organisation");
await step("getOrganizations()", "pass", () => agent.getOrganizations());
out(`       organisation: ${orgId}`);
await step("getOrganization(id) fetches the organisation", "pass", async () => {
  const org = await agent.getOrganization(orgId);
  must(org?.id === orgId, `returned ${short(JSON.stringify(org))}`);
});
await agent.setOrganization({ id: orgId });
await step("getOrganization() returns the one set with setOrganization()", "pass", async () => {
  const org = await agent.getOrganization();
  must(org?.id === orgId, `returned ${short(JSON.stringify(org))}`);
});
await step("updateOrganization(id, {})  (no-op update, organisationId must not be added)", "pass",
  () => agent.updateOrganization(orgId, {}));

out("\n== Agent hygiene");
await step("api() does not modify the caller's params", "pass", async () => {
  const params = { name: NAME };
  await agent.getKeys(params);
  must(JSON.stringify(params) === JSON.stringify({ name: NAME }), `params became ${JSON.stringify(params)}`);
});
await step("failed calls do not log credentials", "pass", async () => {
  const logged = [];
  console.log = console.error = console.warn = (...args) => logged.push(args.map(String).join(" "));
  await agent.getKey("00000000-0000-0000-0000-000000000000"); // 404
  const secrets = [auth.api_token, auth.client_secret].filter(Boolean);
  must(logged.length > 0, "nothing was logged");
  must(!logged.some((l) => secrets.some((s) => l.includes(s))), "credential found in the agent's log output");
});
await step("failed calls do not log the request body", "pass", async () => {
  const logged = [];
  console.log = console.error = console.warn = (...args) => logged.push(args.map(String).join(" "));
  const marker = `body-marker-${ts}`;
  // invalid key type: rejected by the server, nothing is created
  must((await agent.createKey({ name: marker, keyType: "NO_SUCH_TYPE", keyParams: {}, storageType: "NO_SUCH_STORAGE", storageParams: {} })) === false,
    "invalid key was accepted");
  must(logged.length > 0, "nothing was logged");
  must(!logged.some((l) => l.includes(marker)), "request body found in the agent's log output");
});

out("\n== Keys and DIDs");
const key = await step("createKey()", "pass", async () => {
  const k = await agent.createKey({ name: NAME, keyType: KEY_ALG, keyParams: {}, storageType: KEY_STORAGE, storageParams: {} });
  must(k?.id, "no id");
  return k;
});
await step("getKeys({ name })", "pass", async () => {
  const l = await agent.getKeys({ name: NAME });
  must(l?.values?.length >= 1, "key not listed");
});
if (key) await step("getKey(id)", "pass", () => agent.getKey(key.id));
if (key) await step("generateCSR()", "pass",
  () => agent.generateCSR(key.id, { profile: "GENERIC", subject: { commonName: NAME, countryName: "FI" } }));

const identifier = key && await step(`createDID() method=${DID_METHOD}`, "pass", async () => {
  const keys = DID_METHOD === "KEY"
    ? { authentication: [key.id], assertionMethod: [key.id] }
    : { authentication: [key.id], assertionMethod: [key.id], keyAgreement: [key.id], capabilityInvocation: [key.id], capabilityDelegation: [key.id] };
  const r = await agent.createDID({ name: NAME, method: DID_METHOD, keys });
  must(r?.id, "no id");
  created.dids.push(r.id);
  return r;
});
const did = identifier && await step("getDID(id)", "pass", async () => {
  const d = await agent.getDID(identifier.id);
  must(d?.did?.did, `no did.did in ${short(JSON.stringify(d))}`);
  return d;
});
await step("getDIDs({ name })", "pass", async () => {
  const l = await agent.getDIDs({ name: NAME });
  must(l?.values?.length >= 1, "DID not listed");
});
await step("getDIDs() with no params", "pass", async () => {
  const l = await agent.getDIDs();
  must(Array.isArray(l?.values), "no values");
});
if (did) await step("resolveDID(did)", "info", () => agent.resolveDID(did.did.did));
if (did) await step("getTrustEntity(didId) returns false without calling the removed endpoint", "pass", async () => {
  const before = calls.length;
  must((await agent.getTrustEntity(did.did.id)) === false, "did not return false");
  must(calls.length === before, "made an HTTP call");
});

out("\n== Credential schemas");
const schemaPayload = (suffix, format) => ({
  name: `${NAME}${suffix}`,
  formats: [format],
  allowRevocation: false,
  allowSuspension: false,
  claims: [
    {
      key: "Person",
      datatype: "OBJECT",
      required: true,
      claims: [
        { key: "given_name", datatype: "STRING", required: true },
        { key: "family_name", datatype: "STRING", required: false },
      ],
    },
  ],
});
const vct = (suffix) => `https://example.com/credentials/${NAME}${suffix}`;
// v1.90 rejects the pre-1.90 field names; scripts/upgrade-schema.js converts them.
const oldSchema = {
  ...schemaPayload("-old", { format: FORMAT, schemaId: vct("-old") }),
  requiresWalletInstanceAttestation: false,
  keyStorageSecurity: "HIGH",
};
await step("createCredentialSchema() with pre-1.90 field names is rejected", "fail", async () => {
  const r = await agent.createCredentialSchema(oldSchema);
  if (r?.id) created.credentialSchemas.push(r.id);
  must(r?.id, "no id");
});
await step("scripts/upgrade-schema.js output is accepted and stored in the new form", "pass", async () => {
  const r = await agent.createCredentialSchema(upgradeCredentialSchema(oldSchema));
  if (r?.id) created.credentialSchemas.push(r.id);
  must(r?.id, "no id");
  const s = await agent.getCredentialSchema(r.id);
  must(s?.formats?.[0]?.ecosystemSchemaId === vct("-old"), `formats = ${short(JSON.stringify(s?.formats))}`);
  must(s?.walletAttestation?.requireInstanceAttestation === false && s?.walletAttestation?.keyStorageSecurityLevel === "HIGH",
    `walletAttestation = ${short(JSON.stringify(s?.walletAttestation))}`);
});

const credSchemaId = await step("createCredentialSchema() new ecosystemSchemaId + walletAttestation", "pass", async () => {
  const r = await agent.createCredentialSchema({
    ...schemaPayload("", { format: FORMAT, ecosystemSchemaId: vct("") }),
    walletAttestation: { requireInstanceAttestation: false },
  });
  must(r?.id, "no id");
  created.credentialSchemas.push(r.id);
  return r.id;
});
await step("getCredentialSchemas({ name })", "pass", async () => {
  const l = await agent.getCredentialSchemas({ name: NAME, sort: "createdDate", sortDirection: "DESC" });
  must(l?.values?.length >= 1, "schema not listed");
});
await step("getCredentialSchemas({ 'ecosystemSchemaIds[]' })", "pass", async () => {
  const l = await agent.getCredentialSchemas({ "ecosystemSchemaIds[]": vct("") });
  const names = l?.values?.map((v) => v.name) || [];
  must(l?.values?.some((v) => v.id === credSchemaId), `schema not in result: ${short(JSON.stringify(names))}`);
  must(names.every((n) => n.startsWith(NAME)), `filter not applied: ${short(JSON.stringify(names))}`);
  return `${names.length} match(es): ${names.join(", ")}`;
});
const credSchema = credSchemaId && await step("getCredentialSchema(id)", "pass", () => agent.getCredentialSchema(credSchemaId));
if (credSchema) await step("response formats[0] has ecosystemSchemaId, not schemaId", "pass", () => {
  const f = credSchema.formats?.[0] || {};
  must(f.ecosystemSchemaId, `formats[0] = ${JSON.stringify(f)}`);
  must(!("schemaId" in f), `formats[0] still has schemaId: ${JSON.stringify(f)}`);
  return `formats[0] = ${JSON.stringify({ format: f.format, ecosystemSchemaId: f.ecosystemSchemaId })}`;
});
if (credSchemaId) await step("shareCredentialSchema(id)", "pass", async () => {
  const r = await agent.shareCredentialSchema(credSchemaId);
  must(r?.url, `no url in ${short(JSON.stringify(r))}`);
});

out("\n== Issuance");
const person = credSchema?.claims?.find((c) => c.key === "Person");
const givenName = person?.claims?.find((c) => c.key === "given_name");
const claimValues = givenName ? [{ claimId: givenName.id, value: "Alice", path: "Person/given_name" }] : [];
const issue = async (extra) => {
  const before = calls.length;
  let offer;
  try {
    offer = await agent.issueCredential({ credentialSchemaId: credSchemaId, protocol: ISSUANCE, claimValues, ...extra });
  } finally {
    // record the created credential even if sharing it failed
    const create = calls.slice(before).find((c) => c.method === "POST" && /\/credential\/v1$/.test(c.path));
    try { const id = JSON.parse(create?.body)?.id; if (id) created.credentials.push(id); } catch {}
  }
  must(offer?.url, `no offer url in ${short(JSON.stringify(offer))}`);
  return created.credentials.at(-1);
};
const credId = credSchemaId && identifier && givenName &&
  await step("issueCredential({ issuer: identifierId })  (pensioncredential style)", "pass",
    () => issue({ issuer: identifier.id, issuerKey: key.id }));
if (credSchemaId && did && givenName)
  await step("issueCredential({ issuerDid: didId })  (deprecated, ips-demo style)", "pass",
    () => issue({ issuerDid: did.did.id, issuerKey: key.id }));
await step("getCredentials() uses the organisation from setOrganization()", "pass", async () => {
  const l = await agent.getCredentials();
  must(Array.isArray(l?.values), "no values");
});
await step("getCredentials({ organisationId })", "pass", async () => {
  const l = await agent.getCredentials({ organisationId: orgId });
  must(Array.isArray(l?.values), "no values");
});
if (credId) await step("getCredential(id)", "pass", async () => {
  const c = await agent.getCredential(credId);
  must(c?.id === credId, "wrong credential");
  return `state: ${c.state}`;
});
if (credId) await step("checkRevocationStatus({ credentialIds })", "info",
  () => agent.checkRevocationStatus({ credentialIds: [credId] }));

out("\n== Proof schemas and requests");
const proofSchemaId = credSchemaId && givenName && await step("createVerificationSchema()", "pass", async () => {
  const r = await agent.createVerificationSchema({
    name: NAME,
    expireDuration: 0,
    proofInputSchemas: [{ credentialSchemaId: credSchemaId, claimSchemas: [{ id: givenName.id, required: true }] }],
  });
  must(r?.id, "no id");
  created.proofSchemas.push(r.id);
  return r.id;
});
await step("getVerificationSchemas({ name })", "pass", async () => {
  const l = await agent.getVerificationSchemas({ name: NAME });
  must(l?.values?.length >= 1, "proof schema not listed");
});
if (proofSchemaId) await step("getVerificationSchema(id)", "pass", () => agent.getVerificationSchema(proofSchemaId));
if (proofSchemaId) await step("shareVerificationSchema(id)", "pass", async () => {
  const r = await agent.shareVerificationSchema(proofSchemaId);
  must(r?.url, `no url in ${short(JSON.stringify(r))}`);
});

const request = async (extra) => {
  const before = calls.length;
  try {
    const r = await agent.requestCredential({ proofSchemaId, protocol: VERIFICATION, ...extra });
    must(r?.url, `no url in ${short(JSON.stringify(r))}`);
    return r.id;
  } finally {
    // record the created proof request even if sharing it failed
    const create = calls.slice(before).find((c) => c.method === "POST" && /\/proof-request\/v1$/.test(c.path));
    try { const id = JSON.parse(create?.body)?.id; if (id) created.proofRequests.push(id); } catch {}
  }
};
const proofId = proofSchemaId && identifier &&
  await step("requestCredential({ verifier: identifierId })  (pensioncredential style)", "pass",
    () => request({ verifier: identifier.id }));
if (proofSchemaId && did)
  await step("requestCredential({ verifierDid: didId })  (deprecated, ips-demo style)", "pass",
    () => request({ verifierDid: did.did.id }));
if (proofSchemaId && identifier)
  await step("requestCredential({ clientIdScheme: 'did' })", "info",
    () => request({ verifier: identifier.id, clientIdScheme: "did" }));
if (proofId) await step("getStatus(id)", "pass", async () => {
  const p = await agent.getStatus(proofId);
  must(p?.id === proofId, "wrong proof");
  return `state: ${p.state}`;
});
await step("getProofRequests() uses the organisation from setOrganization()", "pass", async () => {
  const l = await agent.getProofRequests();
  must(Array.isArray(l?.values), "no values");
});
await step("getProofRequests({ organisationId })", "pass", async () => {
  const l = await agent.getProofRequests({ organisationId: orgId });
  must(Array.isArray(l?.values), "no values");
});

out("\n== Not tested");
out("       revoke/suspend/reactivateCredential, deleteClaimData: need a wallet to accept/submit first");
out("       importCredentialSchema/importVerificationSchema: would duplicate into the same organisation");
out("       createOrganization, getCertificate: skipped (permanent object / no certificate at hand)");

if (env.PROCIVIS_KEEP === "1") {
  out(`\n== Cleanup skipped (PROCIVIS_KEEP). Created: ${JSON.stringify(created)}`);
} else {
  out("\n== Cleanup");
  for (const id of created.proofRequests) await step(`deleteProofRequest(${id})`, "info", () => agent.deleteProofRequest(id));
  for (const id of created.proofSchemas) await step(`deleteVerificationSchema(${id})`, "pass", () => agent.deleteVerificationSchema(id));
  for (const id of created.credentials) await step(`deleteCredential(${id})`, "info", () => agent.deleteCredential(id));
  for (const id of created.credentialSchemas) await step(`deleteCredentialSchema(${id})`, "pass", () => agent.deleteCredentialSchema(id));
  for (const id of created.dids) await step(`deleteDID(${id})`, "info", () => agent.deleteDID(id));
  if (key) out(`       key ${key.id} (${NAME}) left in place: the agent has no key delete`);
}

const unexpected = results.filter((r) => !r.matches);
out(`\n== Summary: ${results.length} steps, ${unexpected.length} unexpected`);
for (const r of unexpected) out(`   XX ${r.name}: expected ${r.expect}, got ${r.actual}`);
process.exit(unexpected.length ? 1 : 0);
