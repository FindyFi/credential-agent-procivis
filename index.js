// Endpoints that accept organisationId; the others reject unknown fields.
const ORG_SCOPED_LISTS = [
  "/key/v1",
  "/identifier/v1",
  "/credential-schema/v2",
  "/proof-schema/v1",
  "/credential/v1",
  "/proof-request/v1",
];
const ORG_SCOPED_BODIES = [
  "/key/v1",
  "/identifier/v1",
  "/credential-schema/v2",
  "/credential-schema/v2/import",
  "/proof-schema/v1",
  "/proof-schema/v1/import",
];

// Maps pre-v1.90 credential schema fields to their new names; new fields win.
function upgradeCredentialSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const { requiresWalletInstanceAttestation, keyStorageSecurity, ...upgraded } = schema;
  if (Array.isArray(schema.formats)) {
    upgraded.formats = schema.formats.map(({ schemaId, ...format }) => ({
      ...format,
      ...(format.ecosystemSchemaId === undefined && schemaId !== undefined
        ? { ecosystemSchemaId: schemaId }
        : {}),
    }));
  }
  const walletAttestation = { ...schema.walletAttestation };
  if (requiresWalletInstanceAttestation && walletAttestation.requireInstanceAttestation === undefined) {
    walletAttestation.requireInstanceAttestation = true;
  }
  if (keyStorageSecurity != null && walletAttestation.keyStorageSecurityLevel === undefined) {
    walletAttestation.keyStorageSecurityLevel = keyStorageSecurity;
  }
  if (Object.keys(walletAttestation).length > 0) {
    upgraded.walletAttestation = walletAttestation;
  }
  return upgraded;
}

class Agent {
  MAX_TTL = Math.pow(2, 31) - 1; // setTimeout accepts max 32 bit integers

  // private, so credentials and the token don't show up when the agent is logged
  #auth = {};
  #headers;

  constructor(options = {}) {
    if (!options.api_base) {
      throw new Error("api_base is required");
    }
    this.options = { api_base: options.api_base.replace(/\/+$/, "") };
    this.schemas = options.schemas || {};
    this.#headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    });
  }

  async authenticate(data) {
    if (data) {
      this.#auth = { ...data };
    }
    const { api_token, client_id, client_secret, token_endpoint } = this.#auth;
    if (api_token) {
      this.#headers.set("Authorization", `Bearer ${api_token}`);
      return true;
    }
    if (!client_id || !client_secret || !token_endpoint) {
      throw new Error("authenticate() needs api_token, or client_id, client_secret and token_endpoint");
    }
    const response = await fetch(token_endpoint, {
      method: "POST",
      body: new URLSearchParams({ client_id, client_secret, grant_type: "client_credentials" }),
    });
    if (!response.ok) {
      console.error(response.status, token_endpoint, await response.text());
      throw new Error("Authentication failed!");
    }
    await this.setAuthParams(await response.json());
    return true;
  }

  async setAuthParams(data) {
    if (!data?.access_token) {
      throw new Error("Authentication failed!");
    }
    this.#headers.set("Authorization", `Bearer ${data.access_token}`);
    if (data.expires_in) {
      setTimeout(() => { this.authenticate() }, Math.min(data.expires_in * 1000, this.MAX_TTL));
    }
    return data;
  }

  async api(method, path, body = {}) {
    body = { ...body }; // never modify the caller's object
    let url = `${this.options.api_base}${path}`;
    const options = { method, headers: this.#headers };
    const orgScoped = method == "GET" ? ORG_SCOPED_LISTS : method == "POST" ? ORG_SCOPED_BODIES : [];
    if (this.org?.id && orgScoped.includes(path) && body.organisationId === undefined) {
      body.organisationId = this.org.id;
    }
    if (method == "POST" || method == "PATCH" || method == "PUT") {
      options.body = JSON.stringify(body);
    } else if (method == "GET") {
      body.page = body.page !== undefined ? body.page : 0;
      body.pageSize = body.pageSize !== undefined ? body.pageSize : 20;
      const queryParams = new URLSearchParams(body);
      url = `${url}?${queryParams.toString()}`;
    }
    const resp = await fetch(url, options);
    if (!resp.ok) {
      // only the error code: the request and the server's error cause can hold tokens or personal data
      const error = await resp.json().catch(() => ({}));
      console.error(resp.status, method, `${this.options.api_base}${path}`, error.code ?? "", error.message ?? "");
      return false;
    }
    let data;
    if (resp.headers.get("Content-Type")?.includes("application/json")) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }
    if (method == "GET" && data.totalPages > body.page + 1) {
      body.page++;
      const nextPageData = await this.api(method, path, body);
      if (nextPageData && nextPageData.values) {
        data.values = data.values.concat(nextPageData.values);
      }
    }
    return data;
  }

  // /system endpoints live at the server root, not under api_base
  async system(path) {
    return fetch(`${this.options.api_base.replace(/\/api$/, "")}${path}`, { headers: this.#headers });
  }

  /* Generic credential agent methods */

  async createOrganization(data) {
    return this.api("POST", "/organisation/v1", data);
  }

  async getOrganizations(params) {
    return this.api("GET", "/organisation/v1", params);
  }

  // Without an id, returns the organisation set with setOrganization()
  async getOrganization(id) {
    if (id == null) {
      return this.org;
    }
    return this.api("GET", `/organisation/v1/${encodeURIComponent(id)}`);
  }

  async updateOrganization(id, data) {
    return this.api(
      "PATCH",
      `/organisation/v1/${encodeURIComponent(id)}`,
      data
    );
  }

  async deleteOrganization(id) {
    return false;
  }

  async createKey(data) {
    return this.api("POST", "/key/v1", data);
  }

  async getKeys(params) {
    return this.api("GET", "/key/v1", params);
  }

  async getKey(id) {
    return this.api("GET", `/key/v1/${encodeURIComponent(id)}`);
  }

  async deleteKey(id) {
    return false;
  }

  async createDID(data) {
    if (!data.name || !data.method || !data.keys) {
      throw new Error("DID data must include name, method, and keys");
    }
    if (!data.keys.assertionMethod || data.keys.assertionMethod.length === 0) {
      throw new Error("DID data must include at least one assertionMethod key");
    }
    const params = {
      name: data.name,
      did: {
        method: data.method,
        name: data.name,
        keys: data.keys,
      },
    };
    if (data.params?.externalHostingUrl) {
      params.did.params = {
        externalHostingUrl: data.params.externalHostingUrl,
      };
    }
    return this.api("POST", "/identifier/v1", params);
  }

  async getDIDs(params = {}) {
    return this.api("GET", "/identifier/v1", { ...params, "types[]": "DID" });
  }

  async getDID(id) {
    return this.api("GET", `/identifier/v1/${encodeURIComponent(id)}`);
  }

  async deleteDID(id) {
    return this.api("DELETE", `/identifier/v1/${encodeURIComponent(id)}`);
  }

  async createCredentialSchema(data) {
    return this.api("POST", "/credential-schema/v2", upgradeCredentialSchema(data));
  }

  // schemaId is the pre-v1.90 name of the ecosystemSchemaIds[] filter
  async getCredentialSchemas(params = {}) {
    const { schemaId, ...query } = params;
    if (schemaId !== undefined && query["ecosystemSchemaIds[]"] === undefined) {
      query["ecosystemSchemaIds[]"] = schemaId;
    }
    return this.api("GET", "/credential-schema/v2", query);
  }

  async getCredentialSchema(id) {
    return this.api("GET", `/credential-schema/v2/${encodeURIComponent(id)}`);
  }

  async deleteCredentialSchema(id) {
    return this.api(
      "DELETE",
      `/credential-schema/v1/${encodeURIComponent(id)}`
    );
  }

  async issueCredential(data) {
    const cred = await this.createCredential(data);
    if (!cred || !cred.id) {
      throw new Error("Failed to create credential");
    }
    const offer = await this.api("POST", `/credential/v1/${encodeURIComponent(cred.id)}/share`);
    if (offer) {
      offer.id = cred.id;
    }
    return offer;
  }

  async revokeCredential(id) {
    return this.api("POST", `/credential/v1/${encodeURIComponent(id)}/revoke`);
  }

  async suspendCredential(id) {
    return this.api("POST", `/credential/v1/${encodeURIComponent(id)}/suspend`);
  }

  async reactivateCredential(id) {
    return this.api(
      "POST",
      `/credential/v1/${encodeURIComponent(id)}/reactivate`
    );
  }

  async createVerificationSchema(data) {
    return this.api("POST", "/proof-schema/v1", data);
  }

  async getVerificationSchemas(params) {
    return this.api("GET", "/proof-schema/v1", params);
  }

  async getVerificationSchema(id) {
    return this.api("GET", `/proof-schema/v1/${encodeURIComponent(id)}`);
  }

  async deleteVerificationSchema(id) {
    return this.api(
      "DELETE",
      `/proof-schema/v1/${encodeURIComponent(id)}`
    );
  }

  async requestCredential(data) {
    const { clientIdScheme = "redirect_uri", ...proofRequest } = data;
    const request = await this.createProofRequest(proofRequest);
    if (!request || !request.id) {
      throw new Error("Failed to create proof request");
    }
    const offer = await this.api(
      "POST",
      `/proof-request/v1/${encodeURIComponent(request.id)}/share`,
      { params: { clientIdScheme } }
    );
    if (!offer) {
      throw new Error("Failed to share proof request");
    }
    offer.id = request.id;
    return offer;
  }

  async getStatus(id) {
    return this.getProofRequest(id);
  }

  /* Vendor-specific methods */

  async setOrganization(org) {
    this.org = org;
  }

  async getConfiguration() {
    return this.api("GET", "/config/v1");
  }

  async getVersion() {
    const resp = await this.system("/system/build-info");
    if (!resp.ok) {
      console.error(resp.status, "GET /system/build-info");
      return false;
    }
    return resp.json();
  }

  async health() {
    const resp = await this.system("/system/health/liveness");
    return resp.ok;
  }

  async getCertificate(id) {
    return this.api("GET", `/certificate/v1/${encodeURIComponent(id)}`);
  }

  async generateCSR(id, data) {
    return this.api(
      "POST",
      `/key/v1/${encodeURIComponent(id)}/generate-csr`,
      data
    );
  }

  // Removed from One Core; see POST /identifier/v1/resolve-trust-entries
  async getTrustEntity(id) {
    console.warn("getTrustEntity() is not supported by One Core v1.79 and later");
    return false;
  }

  async resolveDID(did) {
    return this.api("GET", `/did-resolver/v1/${encodeURIComponent(did)}`);
  }

  async importCredentialSchema(data) {
    return this.api("POST", "/credential-schema/v2/import", {
      ...data,
      schema: upgradeCredentialSchema(data?.schema),
    });
  }

  async shareCredentialSchema(id) {
    return this.api("POST", `/credential-schema/v2/${encodeURIComponent(id)}/share`);
  }

  async createCredential(data) {
    return this.api("POST", "/credential/v1", data);
  }

  async getCredentials(params) {
    return this.api("GET", "/credential/v1", params);
  }

  async getCredential(id) {
    return this.api("GET", `/credential/v1/${encodeURIComponent(id)}`);
  }

  async deleteCredential(id) {
    return this.api("DELETE", `/credential/v1/${encodeURIComponent(id)}`);
  }

  async checkRevocationStatus(data) {
    return this.api("POST", `/credential/v1/revocation-check`, data);
  }

  async shareVerificationSchema(id) {
    return this.api("POST", `/proof-schema/v1/${encodeURIComponent(id)}/share`);
  }

  async importVerificationSchema(data) {
    return this.api("POST", "/proof-schema/v1/import", data);
  }

  async createProofRequest(data) {
    return this.api("POST", "/proof-request/v1", data);
  }

  async getProofRequests(params) {
    return this.api("GET", "/proof-request/v1", params);
  }

  async getProofRequest(id) {
    return this.api("GET", `/proof-request/v1/${encodeURIComponent(id)}`);
  }

  async deleteProofRequest(id) {
    return this.api("DELETE", `/proof-request/v1/${encodeURIComponent(id)}`);
  }

  async deleteClaimData(id) {
    return this.api("DELETE", `/proof-request/v1/${encodeURIComponent(id)}/claims`);
  }

}

export { Agent };
