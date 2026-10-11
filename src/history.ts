import {
  PublicKey,
  TransactionInstruction,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SWIG_PROGRAM_ADDRESS } from '@swig-wallet/classic';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const AGENT_MEMO_PREFIX = 'karai:agent-spend:';

/** Agent transactions carry the attempted amount, so rejected attempts stay readable onchain. */
export function agentSpendMemo(amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(`${AGENT_MEMO_PREFIX}${amount}`) as Buffer,
  });
}

/** First u16 of Swig instruction data. */
const SWIG_IX = { create: 0, addAuthority: 1, removeAuthority: 2, signV2: 11 } as const;

export type HistoryEntry = {
  signature: string;
  /** Unix seconds, null if the cluster didn't report it. */
  time: number | null;
  kind:
    | 'wallet-created'
    | 'agent-granted'
    | 'agent-revoked'
    | 'sent'
    | 'received'
    | 'agent-spent'
    | 'agent-rejected'
    | 'failed'
    | 'other';
  /** Base units of the tracked mint. Positive for received, positive for spends too. */
  amount: bigint | null;
  /** Why an agent spend failed: over its limit, a payee the user didn't allow, or not enough balance. */
  reason?: 'policy' | 'destination' | 'balance';
};

/**
 * Rebuild a wallet's activity from the chain: everything that touched the Swig
 * account (owner and agent actions) plus incoming transfers to its token account.
 */
export async function walletHistory(
  connection: Connection,
  args: { swigAddress: string; walletAddress: string; mint: string; limit?: number },
  /** Entries are immutable once confirmed, so callers can keep them between polls. */
  cache: Map<string, HistoryEntry> = new Map(),
): Promise<HistoryEntry[]> {
  const limit = args.limit ?? 25;
  const wallet = new PublicKey(args.walletAddress);
  const ata = getAssociatedTokenAddressSync(new PublicKey(args.mint), wallet, true);

  const [swigSigs, ataSigs] = await Promise.all([
    connection.getSignaturesForAddress(new PublicKey(args.swigAddress), { limit }),
    connection.getSignaturesForAddress(ata, { limit }),
  ]);
  const unique = new Map([...swigSigs, ...ataSigs].map((s) => [s.signature, s]));
  const sigs = [...unique.values()].sort((a, b) => b.slot - a.slot).slice(0, limit);
  if (sigs.length === 0) return [];

  // One request per signature, a few at a time: batched getParsedTransactions is
  // rate-limited on public RPCs, and batch responses may come back out of order.
  const missing = sigs.filter((s) => !cache.has(s.signature));
  await mapLimit(missing, 3, async (sig) => {
    try {
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      // null means the RPC hasn't indexed it yet: retry on the next call.
      if (tx) cache.set(sig.signature, classify(sig.signature, sig.blockTime ?? null, tx, ata, args.mint));
    } catch {
      // rate-limited or flaky RPC: retry on the next call
    }
  });
  return sigs.flatMap((s) => cache.get(s.signature) ?? []);
}

function classify(
  signature: string,
  time: number | null,
  tx: ParsedTransactionWithMeta | null,
  ata: PublicKey,
  mint: string,
): HistoryEntry {
  const base = { signature, time, amount: null };
  if (!tx?.meta) return { ...base, kind: 'other' };

  const failed = tx.meta.err !== null;
  const instructions = tx.transaction.message.instructions;
  const swigIx = instructions.find((ix) => ix.programId.equals(SWIG_PROGRAM_ADDRESS)) as
    | PartiallyDecodedInstruction
    | undefined;
  const disc = swigIx ? discriminator(swigIx.data) : null;
  // Owner (passkey) actions are signed by the fee payer only; agents add their own signature.
  const byAgent = tx.transaction.message.accountKeys.filter((k) => k.signer).length > 1;

  const ataIndex = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(ata));
  const balance = (list: typeof tx.meta.preTokenBalances) =>
    BigInt(list?.find((b) => b.accountIndex === ataIndex && b.mint === mint)?.uiTokenAmount.amount ?? '0');
  const delta = ataIndex >= 0 ? balance(tx.meta.postTokenBalances) - balance(tx.meta.preTokenBalances) : 0n;

  if (disc === SWIG_IX.create) return { ...base, kind: 'wallet-created' };
  if (disc === SWIG_IX.addAuthority) return { ...base, kind: failed ? 'failed' : 'agent-granted' };
  if (disc === SWIG_IX.removeAuthority) return { ...base, kind: failed ? 'failed' : 'agent-revoked' };

  if (disc === SWIG_IX.signV2) {
    if (!failed) return { ...base, kind: byAgent ? 'agent-spent' : 'sent', amount: -delta };
    if (!byAgent) return { ...base, kind: 'failed' };
    const logs = tx.meta.logMessages ?? [];
    const tokenFailed = logs.some((l) => l.startsWith(`Program ${TOKEN_PROGRAM_ID.toBase58()} failed`));
    // Swig's PermissionDeniedMissingPermission: no destination limit covers the payee.
    const missingPermission = logs.some((l) => l.startsWith(`Program ${SWIG_PROGRAM_ADDRESS.toBase58()} failed`) && l.endsWith('0xbbe'));
    const reason = tokenFailed ? 'balance' : missingPermission ? 'destination' : 'policy';
    return { ...base, kind: 'agent-rejected', amount: memoAmount(instructions), reason };
  }

  if (!failed && delta > 0n) return { ...base, kind: 'received', amount: delta };
  return { ...base, kind: failed ? 'failed' : 'other' };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function discriminator(data: string): number | null {
  const bytes = decodeBase58(data);
  return bytes.length >= 2 ? bytes[0] | (bytes[1] << 8) : null;
}

function memoAmount(instructions: (ParsedInstruction | PartiallyDecodedInstruction)[]): bigint | null {
  for (const ix of instructions) {
    if (!ix.programId.equals(MEMO_PROGRAM_ID) || !('parsed' in ix) || typeof ix.parsed !== 'string') continue;
    if (ix.parsed.startsWith(AGENT_MEMO_PREFIX)) {
      try {
        return BigInt(ix.parsed.slice(AGENT_MEMO_PREFIX.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value: string): Uint8Array {
  let n = 0n;
  for (const char of value) {
    const digit = B58.indexOf(char);
    if (digit < 0) return new Uint8Array();
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
