import crypto from 'node:crypto';
import type { Connection } from '@solana/web3.js';
import { findSwigPda } from '@swig-wallet/classic';
import { isSecp256r1BasedAuthority } from '@swig-wallet/lib';
import { fromBase64Url, swigIdFromCredential, type PasskeyAssertion } from './passkey';
import { loadSwig, ownerRole, walletAddressOf } from './swig';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * Sign in with Karai: check that a passkey assertion signs `challenge` and return the
 * wallet that passkey owns. The public key is read from the wallet onchain, so the
 * server keeps no user table.
 */
export async function verifyPasskeyAssertion(opts: {
  connection: Connection;
  assertion: PasskeyAssertion;
  /** The base64url challenge the server issued. */
  challenge: string;
  /** Expected page origin, e.g. https://app.example.com */
  origin: string;
  /** Expected WebAuthn relying party id, e.g. app.example.com */
  rpId: string;
}): Promise<{ swigAddress: string; walletAddress: string }> {
  const { assertion } = opts;
  const clientDataJSON = Buffer.from(fromBase64Url(assertion.clientDataJSON));
  const authenticatorData = Buffer.from(fromBase64Url(assertion.authenticatorData));

  const clientData = JSON.parse(clientDataJSON.toString('utf8')) as { type?: string; challenge?: string; origin?: string };
  if (clientData.type !== 'webauthn.get') throw new Error('Not a passkey sign-in');
  if (clientData.challenge !== opts.challenge) throw new Error('Challenge mismatch');
  if (clientData.origin !== opts.origin) throw new Error('Origin mismatch');

  const rpIdHash = crypto.createHash('sha256').update(opts.rpId).digest();
  if (authenticatorData.length < 37 || !authenticatorData.subarray(0, 32).equals(rpIdHash)) {
    throw new Error('Relying party mismatch');
  }
  const flags = authenticatorData[32];
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) throw new Error('User was not verified');

  const swigAddress = findSwigPda(await swigIdFromCredential(assertion.credentialId));
  const swig = await loadSwig(opts.connection, swigAddress).catch(() => {
    throw new Error('This passkey has no Karai wallet');
  });
  const { authority } = ownerRole(swig);
  if (!isSecp256r1BasedAuthority(authority)) throw new Error('This wallet has no passkey owner');

  const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const valid = crypto.verify(
    'sha256',
    signed,
    { key: p256PublicKey(authority.secp256r1PublicKey), dsaEncoding: 'der' },
    Buffer.from(fromBase64Url(assertion.signature)),
  );
  if (!valid) throw new Error('Invalid passkey signature');

  return { swigAddress: swigAddress.toBase58(), walletAddress: (await walletAddressOf(swig)).toBase58() };
}

/** Node key object from a 33-byte compressed P-256 point, as Swig stores it. */
function p256PublicKey(compressed: Uint8Array): crypto.KeyObject {
  const point = crypto.ECDH.convertKey(Buffer.from(compressed), 'prime256v1', undefined, undefined, 'uncompressed') as Buffer;
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  });
}
