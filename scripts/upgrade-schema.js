#!/usr/bin/env node
// Converts a credential schema JSON file written for One Core before v1.90 to
// the v1.90 field names and prints the result:
//
//   npx upgrade-credential-schema old.json > new.json
//
//   formats[].schemaId                 -> formats[].ecosystemSchemaId
//   requiresWalletInstanceAttestation  -> walletAttestation.requireInstanceAttestation
//   keyStorageSecurity                 -> walletAttestation.keyStorageSecurityLevel
//
// Fields already in the new form are kept as they are.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function upgradeCredentialSchema(schema) {
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
  if (requiresWalletInstanceAttestation !== undefined && walletAttestation.requireInstanceAttestation === undefined) {
    walletAttestation.requireInstanceAttestation = requiresWalletInstanceAttestation;
  }
  if (keyStorageSecurity != null && walletAttestation.keyStorageSecurityLevel === undefined) {
    walletAttestation.keyStorageSecurityLevel = keyStorageSecurity;
  }
  if (Object.keys(walletAttestation).length > 0) {
    upgraded.walletAttestation = walletAttestation;
  }
  return upgraded;
}

// realpath: npm runs the command through a link in node_modules/.bin
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: upgrade-credential-schema <schema.json>");
    process.exit(2);
  }
  const schema = JSON.parse(readFileSync(file, "utf8"));
  console.log(JSON.stringify(upgradeCredentialSchema(schema), null, 2));
}
