class Agent {
  MAX_TTL = Math.pow(2, 31) - 1; // setTimeout accepts max 32 bit integers

  constructor(options) {
    this.options = options || {};
    this.schemas = options.schemas || {};
    this.headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    });
    this.auth = options.auth || {};
    if (options.auth) {
      this.authenticate(this.auth);
    }
  }

  async authenticate(data) {
    if (data) {
      this.auth = data;
    }
    if (this.auth.api_token) {
      this.headers.append("Authorization", `Bearer ${this.auth.api_token}`);
      return true;
    }
    if (this.auth.client_id && this.auth.client_secret && this.auth.token_endpoint) {
      const query = new URLSearchParams();
      query.append("client_id", this.auth.client_id);
      query.append("client_secret", this.auth.client_secret);
      query.append("grant_type", "client_credentials");
      const response = await fetch(this.auth.token_endpoint, {
        method: "POST",
        body: query,
      });
      if (!response.ok) {
        console.error(response.status, this.auth.token_endpoint);
        console.log(query.toString());
        console.log(JSON.stringify(await response.json(), null, 1));
        throw new Error("Authentication failed!");
      }
      const json = await response.json();
      console.log(json);
      if (!json) {
        throw new Error("Authentication failed!");
      }
      await this.setAuthParams(json);
      return true;
    }
    return false;
  }

  async setAuthParams(data) {
    this.auth.token = data.access_token;
    if (!this.auth.token) {
      throw new Error("Authentication failed!");
    }
    this.headers.set("Authorization", `Bearer ${this.auth.token}`);
    const exp = data?.expires_in;
    if (exp) {
      const ttl = Math.min(exp * 1000, this.MAX_TTL);
      // console.log(`Refreshing token in ${ttl / 1000 / 3600} hours.`);
      if (exp) {
        setTimeout(() => { this.authenticate() }, ttl);
      }
    }
    return data;
  }

  async api(method, path, body = {}) {
    let url = `${this.options.api_base}${path}`;
    const options = { method, headers: this.headers };
    if (this.org) {
      body.organisationId = body.organisationId || this.org?.id;
    }
    if (method == "POST" || method == "PATCH" || method == "PUT") {
      options.body = JSON.stringify(body);
    } else {
      body.page = body.page !== undefined ? body.page : 0;
      body.pageSize = body.pageSize !== undefined ? body.pageSize : 20;
      const queryParams = new URLSearchParams(body);
      url = `${url}?${queryParams.toString()}`;
    }
    const resp = await fetch(url, options);
    // console.log(resp.status, method, url, headers, JSON.stringify(body, null, 1))
    if (!resp.ok) {
      console.error(
        resp.status,
        method,
        url,
        this.headers,
        JSON.stringify(body, null, 1)
      );
      console.log(await resp.text());
      return false;
    }
    let data;
    if (resp.headers.get("Content-Type")?.includes("application/json")) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }
    if (data.totalPages > body.page + 1) {
      body.page++;
      const nextPageData = await this.api(method, path, body);
      if (nextPageData && nextPageData.values) {
        data.values = data.values.concat(nextPageData.values);
      }
    }
    // console.log('Response: ', JSON.stringify(data, null, 1))
    return data;
  }

  /* Generic credential agent methods */

  async createOrganization(data) {
    return this.api("POST", "/organisation/v1", data);
  }

  async getOrganizations(params) {
    return this.api("GET", "/organisation/v1", params);
  }

  async getOrganization(id) {
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
    /* example data where key is in the format returned by addKey() or getKey()
    {
      name: 'issuer.example.com',
      did: {
        method: 'WEB',
        name: 'issuer.example.com',
        keys: {
          authentication: [key],
          assertionMethod: [key],
          keyAgreement: [key],
          capabilityInvocation: [key],
          capabilityDelegation: [key]
        },
        params: {
          externalHostingUrl: `https://issuer.example.com`
        }
      }
    }
    */

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

  async getDIDs(params) {
    params['types[]'] = 'DID';
    return this.api("GET", "/identifier/v1", params);
  }

  async getDID(id) {
    return this.api("GET", `/identifier/v1/${encodeURIComponent(id)}`);
  }

  async deleteDID(id) {
    // return this.api("PATCH", `/did/v1/${encodeURIComponent(id)}`, { deactivated: true });
    return this.api("DELETE", `/identifier/v1/${encodeURIComponent(id)}`);
  }

  async createCredentialSchema(data) {
    return this.api("POST", "/credential-schema/v1", data);
  }

  async getCredentialSchemas(params) {
    return this.api("GET", "/credential-schema/v1", params);
  }

  async getCredentialSchema(id) {
    return this.api("GET", `/credential-schema/v1/${encodeURIComponent(id)}`);
  }

  async deleteCredentialSchema(id) {
    return this.api(
      "DELETE",
      `/credential-schema/v1/${encodeURIComponent(id)}`
    );
  }

  async issueCredential(data) {
    /* example data:
    {
      credentialSchemaId: credentialSchemaId,
      issuerDid: did,
      issuerKey: key,
      protocol: 'OPENID4VCI_FINAL1',
      claimValues: [
        { claimId: uuid, value: 'Alice', path: 'firstName' }
      ]
    }
    */

    const cred = await this.createCredential(data);
    return this.api("POST", `/credential/v1/${encodeURIComponent(cred.id)}/share`);
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
    /* example data:
    {
      "expireDuration": 0,
      "name": "nameVerificationSchema",
      "organisationId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "proofInputSchemas": [
        {
          "claimSchemas": [
            {
              "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
              "required": true
            }
          ],
          "credentialSchemaId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          "validityConstraint": 0
        }
      ]
    }
    */
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

  async requestCredential(data,) {
    /* example data:
    {
      "credentialSchemaId": verificationSchema,
      "protocol": "OPENID4VCI_FINAL1",
      "verifierDid": did,
      "clientIdScheme": "redirect_uri"
    }
    */
    const shareParams = {
      clientIdScheme: "redirect_uri"
    }
    if (data.clientIdScheme) {
      shareParams.clientIdScheme = data.clientIdScheme;
      delete data.clientIdScheme;
    }
    const request = await this.createProofRequest(data);
    const offer = await this.api("POST", `/proof-request/v1/${encodeURIComponent(request.id)}/share`, shareParams);
    offer.id = request.id;
    return offer;
  }

  async getStatus(id) {
    return await this.getProofRequest(id);
  }

  /* Vendor-specific methods */

  async setOrganization(org) {
    this.org = org;
  }

  async getOrganization() {
    return this.org
  }

  async getConfiguration() {
    return this.api("GET", "/config/v1");
  }

  async getVersion() {
    return this.api("GET", "/build-info");
  }

  async health() {
    return this.api("GET", "/health");
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

  async getTrustEntity(id) {
    return this.api("GET", `/did/v1/${encodeURIComponent(id)}/trust-entity`);
  }

  async resolveDID(did) {
    return this.api("GET", `/did-resolver/v1/${encodeURIComponent(did)}`);
  }

  async importCredentialSchema(data) {
    return this.api("POST", "/credential-schema/v1/import", data);
  }

  async shareCredentialSchema(id) {
    return this.api("POST", `/credential-schema/v1/${encodeURIComponent(id)}/share`);
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
    /* example data:
    {
      credentialIds: [uuid1, uuid2, ...],
      forceRefresh: true
    }
    */
    const id = data.id;
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
