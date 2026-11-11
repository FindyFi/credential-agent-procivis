# credential-agent-procivis

A small JavaScript client for the [Procivis One Core](https://github.com/procivis/one-core) REST API: organisations, keys, DIDs, credential schemas, issuance (OpenID4VCI) and verification (OpenID4VP).

Tested against One Core v1.90.0. No dependencies; needs Node.js 22 or later.

## Install

```sh
npm install credential-agent-procivis
```

## Usage

```js
import { Agent } from "credential-agent-procivis";

const agent = new Agent({ api_base: "https://one-core.example.com/api" });

// Either a static API token...
await agent.authenticate({ api_token: process.env.PROCIVIS_API_TOKEN });
// ...or OAuth client credentials (the token is renewed automatically)
// await agent.authenticate({ client_id, client_secret, token_endpoint });

// Organisation used for creating and listing keys, DIDs, schemas, credentials and proofs
await agent.setOrganization({ id: organisationId });

// Issue: returns an offer with a `url` for the wallet (e.g. as a QR code) and the credential `id`
const offer = await agent.issueCredential({
  credentialSchemaId,
  issuer: identifierId,
  protocol: "OPENID4VCI_FINAL1",
  claimValues: [{ claimId, value: "Alice", path: "Person/given_name" }],
});

// Verify: returns a request with a `url` for the wallet and the proof request `id`
const request = await agent.requestCredential({
  proofSchemaId,
  verifier: identifierId,
  protocol: "OPENID4VP_FINAL1",
});
const proof = await agent.getStatus(request.id); // proof.state, proof.proofInputs
```

See `index.js` for the full list of methods.

### Good to know

- **Errors:** a failed call returns `false` and logs the HTTP status, method, path and the server's error code and message. Tokens and request data are not logged. These throw instead: `new Agent()` without `api_base`, `authenticate()` without credentials or when login fails, and `createDID()`, `issueCredential()` and `requestCredential()` when creating the DID, credential or proof request fails.
- **Health:** `health()` checks the server's liveness endpoint and returns `true` or `false`.
- **Lists:** `get…s()` methods fetch all pages and return them in one `values` array.
- **Organisation:** the organisation from `setOrganization()` is added automatically where the API accepts it; pass `organisationId` yourself to override it.
- **Older field names:** credential schemas written for One Core before v1.90 (`formats[].schemaId`, `requiresWalletInstanceAttestation`, `keyStorageSecurity`, and the `schemaId` list filter) are translated to the new names.

## Testing

`test/live.js` runs every method against a live One Core instance. It creates test objects named `compat-test-*` in the given organisation and deletes them at the end, except one key per run, as keys cannot be deleted. Put the settings in `.env` (required; it is git-ignored):

```sh
PROCIVIS_API_BASE=https://one-core.example.com/api
PROCIVIS_ORG_ID=...
PROCIVIS_API_TOKEN=...
# or PROCIVIS_CLIENT_ID, PROCIVIS_CLIENT_SECRET and PROCIVIS_TOKEN_ENDPOINT
# optional: PROCIVIS_KEEP=1 to keep the created objects
```

```sh
npm run test:live
```

## Changelog

### 0.1.0 (unreleased)

Support for One Core v1.90.0.

- Credential schemas: older field names (`formats[].schemaId`, `requiresWalletInstanceAttestation`, `keyStorageSecurity`) and the `schemaId` list filter are translated to the v1.90 names.
- The organisation is added only to requests that accept it. Fixes `updateOrganization()` and `generateCSR()`; `getCredentials()` and `getProofRequests()` now use the organisation set with `setOrganization()`.
- `issueCredential()` also returns the credential `id`.
- `getVersion()` and `health()` use the `/system` endpoints. `health()` now returns `true` or `false`.
- `getOrganization(id)` fetches the organisation; `getOrganization()` without an id still returns the one set with `setOrganization()`.
- `getDIDs()` works without parameters.
- `getTrustEntity()` returns `false` without calling the server; the endpoint no longer exists in One Core.
- `new Agent()` requires `api_base` and no longer logs in by itself; call `authenticate()`. `authenticate()` throws when no credentials are given.
- Calling `authenticate()` again replaces the `Authorization` header instead of adding a second one.
- `requestCredential()` throws if sharing the proof request fails.
- Logs contain only the HTTP status, path and the server's error code and message: no tokens or request data. Credentials and the token are no longer visible when the agent object is logged.
- Objects passed to the agent are no longer modified.
- Added the live test (`npm run test:live`) and the Apache-2.0 license text.
- Requires Node.js 22 or later (Node.js 20 is end of life).

### 0.0.8 (2026-06-17)

- All credential schema calls use the `/v2` API (deleting still uses `/v1`, which has no v2 equivalent).

### 0.0.7 (2026-06-16)

- Credential schemas are created and listed with the `/v2` API.

### 0.0.6 (2026-02-04)

- `clientIdScheme` is sent inside `params` when sharing a proof request.
- No `organisationId` is sent to `/credential` and `/proof-request`.

### 0.0.1 – 0.0.5 (2025-12-15 – 2025-12-18)

- First releases: the `Agent` class, `getStatus()`, and token renewal by re-authenticating.
