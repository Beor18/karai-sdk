import { getWebAuthnPrefix, secp256r1DerToRawSignature, type SigningFn } from '@swig-wallet/lib';

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** SEC1-compress an uncompressed (0x04 || x || y) P-256 public key. */
export function compressP256(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('Expected a 65-byte uncompressed P-256 public key');
  }
  const out = new Uint8Array(33);
  out[0] = uncompressed[64] & 1 ? 0x03 : 0x02;
  out.set(uncompressed.subarray(1, 33), 1);
  return out;
}

/**
 * The Swig id is derived from the passkey credential id, so a synced passkey
 * is all a user needs to find their wallet again: no Karai database involved.
 */
export async function swigIdFromCredential(credentialId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64Url(credentialId) as BufferSource);
  return new Uint8Array(digest);
}

export type CreatedPasskey = {
  credentialId: string;
  /** 33-byte compressed P-256 public key. */
  publicKey: Uint8Array;
};

export async function createPasskey(opts: { username: string; appName: string; rpId?: string }): Promise<CreatedPasskey> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: opts.appName, id: opts.rpId },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: opts.username,
        displayName: opts.username,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = secp256r1
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled');

  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki) throw new Error('This browser does not expose the passkey public key');
  // SPKI for P-256 ends with the 65-byte uncompressed point.
  const raw = new Uint8Array(spki).slice(-65);

  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), publicKey: compressP256(raw) };
}

/** Ask the browser for any passkey of this site and return its credential id. */
export async function discoverPasskey(rpId?: string): Promise<string> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId,
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey selected');
  return toBase64Url(new Uint8Array(credential.rawId));
}

/** A WebAuthn assertion, base64url-encoded so it can travel as JSON. */
export type PasskeyAssertion = {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

/**
 * Sign a server challenge with the passkey, to prove who owns a wallet
 * (see `verifyPasskeyAssertion` in `@karai/sdk/server`). Without a credential id
 * the browser lets the user pick any passkey of this site.
 */
export async function signChallenge(opts: { challenge: string; credentialId?: string; rpId?: string }): Promise<PasskeyAssertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(opts.challenge) as BufferSource,
      rpId: opts.rpId,
      allowCredentials: opts.credentialId
        ? [{ type: 'public-key', id: fromBase64Url(opts.credentialId) as BufferSource }]
        : undefined,
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey selected');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
    authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
    signature: toBase64Url(new Uint8Array(response.signature)),
  };
}

/**
 * Signs Swig instructions with the passkey. Swig checks a WebAuthn signature in one of
 * two forms: it rebuilds the browser's clientDataJSON from a compact template, or it
 * reads the raw JSON (about 100 to 200 bytes more). Browsers may add keys the template
 * can't express; Chrome adds one at random so sites don't compare against templates.
 * The compact form is used when it reproduces the JSON exactly, the raw one otherwise.
 */
export function passkeySigningFn(credentialId: string, rpId?: string): SigningFn {
  return async (message) => {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: message.slice() as BufferSource,
        rpId,
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) as BufferSource }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error('No passkey selected');
    const response = credential.response as AuthenticatorAssertionResponse;
    const clientDataJSON = new Uint8Array(response.clientDataJSON);
    const authenticatorData = new Uint8Array(response.authenticatorData);
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON as BufferSource));
    const signed = new Uint8Array(authenticatorData.length + clientDataHash.length);
    signed.set(authenticatorData);
    signed.set(clientDataHash, authenticatorData.length);
    return {
      signature: secp256r1DerToRawSignature(new Uint8Array(response.signature)),
      message: signed,
      prefix: fitsSwigTemplate(clientDataJSON)
        ? await getWebAuthnPrefix(clientDataJSON, authenticatorData)
        : rawClientDataPrefix(authenticatorData, clientDataJSON),
    };
  };
}

/** Swig's R1 authentication kind for a raw clientDataJSON. */
const WEBAUTHN_RAW_CLIENT_DATA_JSON = 2;

/** Whether Swig's template (type, challenge, origin, crossOrigin: false, in any order) rebuilds this JSON byte for byte. */
export function fitsSwigTemplate(clientDataJSON: Uint8Array): boolean {
  const text = new TextDecoder().decode(clientDataJSON);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return false;
  }
  const keys = Object.keys(data);
  if (keys.length > 4 || keys.some((k) => !['type', 'challenge', 'origin', 'crossOrigin'].includes(k))) return false;
  if (!keys.includes('type') || !keys.includes('challenge') || ('crossOrigin' in data && data.crossOrigin !== false)) return false;
  const rebuilt = keys.map((k) => (k === 'crossOrigin' ? '"crossOrigin":false' : `"${k}":"${String(data[k])}"`)).join(',');
  return `{${rebuilt}}` === text;
}

/** [kind u16][auth data len u16][auth data][json len u16][json], little-endian. */
function rawClientDataPrefix(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(2 + 2 + authenticatorData.length + 2 + clientDataJSON.length);
  const view = new DataView(prefix.buffer);
  view.setUint16(0, WEBAUTHN_RAW_CLIENT_DATA_JSON, true);
  view.setUint16(2, authenticatorData.length, true);
  prefix.set(authenticatorData, 4);
  view.setUint16(4 + authenticatorData.length, clientDataJSON.length, true);
  prefix.set(clientDataJSON, 6 + authenticatorData.length);
  return prefix;
}
