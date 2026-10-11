import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/** A party that takes a cut of each payment: the app's own fee, or Karai Cloud's. */
export type FeeRule = {
  /** Shown to the user, e.g. "App" or "Karai". */
  label: string;
  /** Wallet that receives the fee. Its token account is opened if needed. */
  recipient: string;
  /** Share of each payment in basis points: 100 = 1%. */
  bps: number;
  /** Minimum fee in the token's base units, e.g. 1000 = 0.001 USDC. */
  min?: number;
};

export type FeeSchedule = {
  /** Fees apply to payments in this token only. */
  mint: string;
  rules: FeeRule[];
  /**
   * "recipient": fees come out of the amount, like card fees (the payer pays the
   * exact price). "sender": fees go on top (the payee gets the exact amount).
   */
  chargedTo: 'recipient' | 'sender';
};

export type FeeQuote = {
  /** What leaves the payer's wallet. */
  total: bigint;
  /** What the payee receives. */
  net: bigint;
  fees: { label: string; recipient: string; amount: bigint }[];
};

export function feeFor(rule: FeeRule, base: bigint): bigint {
  const share = (base * BigInt(rule.bps)) / 10_000n;
  const min = BigInt(rule.min ?? 0);
  return share > min ? share : min;
}

/** Split a payment into what the payee gets and each fee. No schedule, no fees. */
export function quoteFees(schedule: FeeSchedule | null | undefined, mint: string, amount: bigint): FeeQuote {
  if (!schedule || schedule.mint !== mint || amount <= 0n) return { total: amount, net: amount, fees: [] };
  const fees = schedule.rules
    .map((rule) => ({ label: rule.label, recipient: rule.recipient, amount: feeFor(rule, amount) }))
    .filter((fee) => fee.amount > 0n);
  const sum = fees.reduce((s, fee) => s + fee.amount, 0n);
  return schedule.chargedTo === 'sender' ? { total: amount + sum, net: amount, fees } : { total: amount, net: amount - sum, fees };
}

/**
 * Instructions for a token payment with its fees. `pre` runs at the top level and
 * opens token accounts (the fee payer covers the rent); `inner` moves the tokens and
 * is signed by the wallet, so the user signs the fees along with the payment.
 */
export function paymentInstructions(args: {
  schedule: FeeSchedule | null | undefined;
  mint: PublicKey;
  wallet: PublicKey;
  to: PublicKey;
  amount: bigint;
  payer: PublicKey;
}): {
  pre: TransactionInstruction[];
  /** The token account each `pre` instruction opens; callers may drop the ones that exist. */
  accounts: PublicKey[];
  inner: TransactionInstruction[];
  quote: FeeQuote;
} {
  const { mint, wallet, payer } = args;
  const quote = quoteFees(args.schedule, mint.toBase58(), args.amount);
  if (quote.net <= 0n) throw new Error('The amount does not cover the fees');

  const from = getAssociatedTokenAddressSync(mint, wallet, true);
  const payees = [{ owner: args.to, amount: quote.net }, ...quote.fees.map((f) => ({ owner: new PublicKey(f.recipient), amount: f.amount }))];
  const pre: TransactionInstruction[] = [];
  const accounts: PublicKey[] = [];
  const inner: TransactionInstruction[] = [];
  for (const { owner, amount } of payees) {
    const account = getAssociatedTokenAddressSync(mint, owner, true);
    pre.push(createAssociatedTokenAccountIdempotentInstruction(payer, account, owner, mint));
    accounts.push(account);
    inner.push(createTransferInstruction(from, account, wallet, amount));
  }
  return { pre, accounts, inner, quote };
}

/**
 * Check, from token balances before and after a simulated transaction, that every fee
 * in the schedule was paid. Returns what was paid, or an error message.
 */
export function checkFees(
  schedule: FeeSchedule,
  balances: { owner: string; mint: string; before: bigint; after: bigint }[],
): { ok: true; volume: bigint; fees: FeeQuote['fees'] } | { ok: false; error: string } {
  const moved = balances.filter((b) => b.mint === schedule.mint);
  const outflow = moved.reduce((s, b) => (b.after < b.before ? s + (b.before - b.after) : s), 0n);
  if (outflow === 0n) return { ok: true, volume: 0n, fees: [] };

  const received = new Map<string, bigint>();
  for (const b of moved) if (b.after > b.before) received.set(b.owner, (received.get(b.owner) ?? 0n) + (b.after - b.before));
  const recipients = new Set(schedule.rules.map((r) => r.recipient));
  const feesPaid = [...recipients].reduce((s, r) => s + (received.get(r) ?? 0n), 0n);
  const base = schedule.chargedTo === 'sender' ? outflow - feesPaid : outflow;

  // Rules can share a recipient, so compare per recipient.
  const required = new Map<string, bigint>();
  for (const rule of schedule.rules) required.set(rule.recipient, (required.get(rule.recipient) ?? 0n) + feeFor(rule, base));
  for (const [recipient, amount] of required) {
    if ((received.get(recipient) ?? 0n) < amount) {
      const label = schedule.rules.find((r) => r.recipient === recipient)?.label ?? recipient;
      return { ok: false, error: `Missing ${label} fee` };
    }
  }
  return {
    ok: true,
    volume: base,
    fees: schedule.rules.map((r) => ({ label: r.label, recipient: r.recipient, amount: feeFor(r, base) })).filter((f) => f.amount > 0n),
  };
}
