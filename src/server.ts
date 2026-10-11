import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionError,
  type TransactionInstruction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SWIG_PROGRAM_ADDRESS, getSignInstructions } from '@swig-wallet/classic';
import { payableBy, periodOf, type AgentType } from './agents';
import { AiError, type AgentRun, type AgentTool, type ChatMessage } from './ai';
import { KARAI_CLOUD_URL } from './cloud-url';
import { checkFees, paymentInstructions, type FeeQuote, type FeeSchedule } from './fees';
import { agentSpendMemo } from './history';
import { agentRole, listAgents, loadSwig, walletAddressOf } from './swig';

export * from './swig';
export * from './history';
export * from './auth';
export * from './fees';
export * from './agents';
export * from './ai';

const SECP256R1_PROGRAM_ID = new PublicKey('Secp256r1SigVerify1111111111111111111111111');

export type RelayOptions = {
  connection: Connection;
  feePayer: Keypair;
  /** Max lamports the fee payer may lose per transaction (fees + rent). Default 0.01 SOL. */
  maxSponsorLamports?: number;
  /** Top-level programs the relayer will sponsor. */
  allowedPrograms?: PublicKey[];
  /** Requests per IP per 10 minutes. Default 60. */
  rateLimit?: number;
  /**
   * Platform fees to charge on token payments, fixed or per request (e.g. per app).
   * Clients read them from GET; POST refuses payments that skip them.
   */
  fees?: FeeSchedule | null | ((req: Request) => FeeSchedule | null | Promise<FeeSchedule | null>);
  /** Agents your app offers. Published on GET so the client can show them to users. */
  agents?: AgentType[] | ((req: Request) => AgentType[] | Promise<AgentType[]>);
  /** Called after a sponsored transaction confirms, e.g. to meter usage. */
  onSponsored?: (event: SponsoredEvent) => void | Promise<void>;
};

export type SponsoredEvent = {
  request: Request;
  signature: string;
  /** What the fee payer spent: fees plus rent for new accounts, from simulation. */
  lamports: number;
  /** Swig wallets created by this transaction. */
  walletsCreated: number;
  /** Set when the transaction moved tokens in the fee schedule's mint. */
  payment?: { mint: string; volume: bigint; fees: FeeQuote['fees'] };
};

/** Swig instructions start with a u16 LE discriminator; 0 is CreateV1. */
const SWIG_CREATE = 0;

/**
 * A minimal paymaster. It co-signs as fee payer only when:
 * - every top-level instruction targets an allowed program,
 * - no other signature is required,
 * - simulation shows the fee payer loses at most `maxSponsorLamports`.
 * The last check also covers instructions nested inside Swig's CPI.
 */
export function createRelayHandler(opts: RelayOptions) {
  const { connection, feePayer } = opts;
  const maxLoss = opts.maxSponsorLamports ?? 10_000_000;
  const allowed = new Set(
    (
      opts.allowedPrograms ?? [
        SWIG_PROGRAM_ADDRESS,
        SECP256R1_PROGRAM_ID,
        ComputeBudgetProgram.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ]
    ).map((p) => p.toBase58()),
  );
  const limiter = rateLimiter(opts.rateLimit ?? 60, 10 * 60_000);
  const feesFor = async (req?: Request) =>
    typeof opts.fees === 'function' ? (req ? await opts.fees(req) : null) : (opts.fees ?? null);

  const agentsFor = async (req?: Request) =>
    typeof opts.agents === 'function' ? (req ? await opts.agents(req) : []) : (opts.agents ?? []);

  const GET = async (req?: Request) =>
    Response.json({ feePayer: feePayer.publicKey.toBase58(), fees: await feesFor(req), agents: await agentsFor(req) });

  const POST = async (req: Request) => {
    if (!limiter(req.headers.get('x-forwarded-for') ?? 'local')) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }
    let tx: Transaction;
    try {
      const { transaction } = (await req.json()) as { transaction: string };
      tx = Transaction.from(Buffer.from(transaction, 'base64'));
    } catch {
      return Response.json({ error: 'Invalid transaction' }, { status: 400 });
    }

    if (!tx.feePayer?.equals(feePayer.publicKey)) {
      return Response.json({ error: 'Fee payer must be the relayer' }, { status: 400 });
    }
    const foreign = tx.instructions.find((ix) => !allowed.has(ix.programId.toBase58()));
    if (foreign) {
      return Response.json({ error: `Program not sponsored: ${foreign.programId.toBase58()}` }, { status: 400 });
    }
    const otherSigners = tx.compileMessage().accountKeys.slice(1, tx.compileMessage().header.numRequiredSignatures);
    if (otherSigners.length > 0) {
      return Response.json({ error: 'Only the fee payer may sign' }, { status: 400 });
    }

    // With fees, watch every writable account to see how tokens move in simulation.
    const schedule = await feesFor(req);
    const message = tx.compileMessage();
    const watched = schedule ? message.accountKeys.filter((_, i) => i > 0 && message.isAccountWritable(i)) : [];
    tx.partialSign(feePayer);
    let accountsBefore: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>;
    let before: number;
    let sim: Awaited<ReturnType<Connection['simulateTransaction']>>;
    try {
      accountsBefore = watched.length ? await connection.getMultipleAccountsInfo(watched, 'confirmed') : [];
      before = await connection.getBalance(feePayer.publicKey, 'confirmed');
      sim = await connection.simulateTransaction(tx, undefined, [feePayer.publicKey, ...watched]);
    } catch (e) {
      // Nothing was sent: an RPC hiccup (rate limit, timeout) the client can simply retry.
      const limited = /\b429\b|rate limit/i.test((e as Error).message ?? '');
      return Response.json(
        { error: limited ? 'Solana RPC rate limit (429): nothing was sent, retry in a few seconds' : 'Solana RPC unavailable: nothing was sent, retry' },
        { status: 503 },
      );
    }
    if (sim.value.err) {
      return Response.json({ error: 'Simulation failed', logs: sim.value.logs ?? [] }, { status: 400 });
    }
    const after = sim.value.accounts?.[0]?.lamports ?? 0;
    if (before - after > maxLoss) {
      return Response.json({ error: 'Transaction costs the sponsor too much' }, { status: 400 });
    }

    let payment: SponsoredEvent['payment'];
    if (schedule) {
      const balances = watched.flatMap((_, i) => {
        const pre = tokenBalance(accountsBefore[i]?.owner.toBase58(), accountsBefore[i]?.data);
        const postAccount = sim.value.accounts?.[i + 1];
        const post = tokenBalance(postAccount?.owner, postAccount ? Buffer.from(postAccount.data[0], 'base64') : undefined);
        const info = post ?? pre;
        return info ? [{ owner: info.owner, mint: info.mint, before: pre?.amount ?? 0n, after: post?.amount ?? 0n }] : [];
      });
      const paid = checkFees(schedule, balances);
      if (!paid.ok) return Response.json({ error: paid.error }, { status: 400 });
      if (paid.volume > 0n) payment = { mint: schedule.mint, volume: paid.volume, fees: paid.fees };
    }

    try {
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmed = await connection.confirmTransaction(signature, 'confirmed');
      // It can still fail onchain if state moved since the simulation: the fee is spent, nothing else happened.
      const failed = confirmed.value.err !== null;
      const walletsCreated = failed
        ? 0
        : tx.instructions.filter(
            (ix) => ix.programId.equals(SWIG_PROGRAM_ADDRESS) && ix.data.length >= 2 && ix.data.readUInt16LE(0) === SWIG_CREATE,
          ).length;
      try {
        await opts.onSponsored?.({ request: req, signature, lamports: before - after, walletsCreated, payment: failed ? undefined : payment });
      } catch (e) {
        // Metering must never fail a transaction that already landed.
        console.error('onSponsored failed', e);
      }
      if (failed) return Response.json({ error: 'Transaction failed onchain', signature }, { status: 409 });
      return Response.json({ signature });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };

  return { GET, POST };
}

/** Owner, mint and amount of an SPL token account, or null for anything else. */
function tokenBalance(program: string | undefined, data: Buffer | undefined) {
  if (program !== TOKEN_PROGRAM_ID.toBase58() || !data || data.length < 165) return null;
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
  };
}

export type AgentSpendResult = (
  | { ok: true; signature: string }
  | {
      ok: false;
      /** policy: over the limit. destination: a payee the user didn't allow. */
      reason: 'policy' | 'destination' | 'balance' | 'revoked' | 'error';
      signature?: string;
      logs: string[];
      error: string;
    }
) & {
  /** What the fee payer spent once the transaction landed (fees plus rent), for metering. */
  lamports?: number;
};

/** Swig's PermissionDeniedMissingPermission: no action covers what was attempted. */
const SWIG_MISSING_PERMISSION = 'custom program error: 0xbbe';

/**
 * Spend from a user's wallet as an agent. The agent signs with its own key;
 * the Swig program decides whether the spend fits the role's limits.
 * Rejected spends are still sent (skipPreflight) so the failure is verifiable onchain.
 */
export async function agentSpend(args: {
  connection: Connection;
  agent: Keypair;
  feePayer: Keypair;
  swigAddress: string;
  mint: string;
  to: string;
  amount: bigint;
  /** Your platform fees, taken from the spend the same way as owner payments. */
  fees?: FeeSchedule | null;
}): Promise<AgentSpendResult> {
  const { connection, agent, feePayer } = args;
  const swig = await loadSwig(connection, args.swigAddress);
  const role = agentRole(swig, agent.publicKey);
  if (!role) return { ok: false, reason: 'revoked', logs: [], error: 'Agent has no permissions on this wallet' };

  const { pre, inner } = paymentInstructions({
    schedule: args.fees,
    mint: new PublicKey(args.mint),
    wallet: await walletAddressOf(swig),
    to: new PublicKey(args.to),
    amount: args.amount,
    payer: feePayer.publicKey,
  });
  const instructions: TransactionInstruction[] = [
    agentSpendMemo(args.amount),
    ...pre,
    ...(await getSignInstructions(swig, role.id, inner)),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(feePayer, agent);

  const sim = await connection.simulateTransaction(tx);
  let logs = sim.value.logs ?? [];
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const outcome = await settle(connection, signature, blockhash, lastValidBlockHeight);

  if (outcome === 'unknown') return { ok: false, reason: 'error', signature, logs, error: 'Sent, not confirmed yet' };
  // Prefer the landed transaction's logs: the pre-send simulation may have seen older state.
  let lamports: number | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const landed = await connection
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (landed?.meta) {
      lamports = landed.meta.preBalances[0] - landed.meta.postBalances[0];
      logs = landed.meta.logMessages ?? logs;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!outcome.err) return { ok: true, signature, lamports };
  // The token program failing means the wallet lacked funds; Swig failing on its own means the policy said no.
  const tokenFailed = logs.some((l) => l.startsWith(`Program ${TOKEN_PROGRAM_ID.toBase58()} failed`));
  const swigFailed = logs.find((l) => l.startsWith(`Program ${SWIG_PROGRAM_ADDRESS.toBase58()} failed`));
  const reason = tokenFailed ? 'balance' : swigFailed?.endsWith(SWIG_MISSING_PERMISSION) ? 'destination' : swigFailed ? 'policy' : 'error';
  const messages = {
    balance: 'Not enough balance',
    policy: 'Rejected by the wallet policy',
    destination: 'The user did not allow this payee',
    error: JSON.stringify(outcome.err),
  };
  return { ok: false, reason, signature, logs, error: messages[reason], lamports };
}

/**
 * Once a transaction is sent its outcome lives onchain, so a confirmation hiccup
 * (rate limits, dropped websocket) falls back to polling the signature status.
 */
async function settle(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ err: TransactionError | null } | 'unknown'> {
  try {
    const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    return { err: confirmed.value.err };
  } catch {
    for (let attempt = 0; attempt < 15; attempt++) {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
      const value = status?.value;
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') return { err: value.err };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return 'unknown';
  }
}

/**
 * Your Karai Cloud agents, called from your server with the app's API key. Karai holds
 * each agent's key and pays the gas from your app's credit; the wallet's onchain policy
 * still decides every spend. Use `spend` from your own AI agent, or `chat` to let Karai
 * run the model you chose for the agent in the dashboard (on your provider key).
 */
export function cloudAgents(opts: { appId: string; apiKey: string; cloudUrl?: string }) {
  const base = (opts.cloudUrl ?? KARAI_CLOUD_URL).replace(/\/$/, '');
  return {
    async chat(args: { agent: string; swigAddress: string; messages: ChatMessage[] }): Promise<AgentRun> {
      const res = await fetch(`${base}/api/agents/${opts.appId}/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      const body = (await res.json().catch(() => ({}))) as AgentRun & { error?: string };
      if (!res.ok) throw new AiError(body.error ?? `HTTP ${res.status}`, res.status);
      return body;
    },
    async spend(args: { agent: string; swigAddress: string; to: string; amount: bigint }): Promise<AgentSpendResult> {
      try {
        const res = await fetch(`${base}/api/agents/${opts.appId}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...args, amount: args.amount.toString() }),
        });
        const body = (await res.json()) as AgentSpendResult | { error?: string };
        return 'ok' in body ? body : { ok: false, reason: 'error', logs: [], error: body.error ?? `HTTP ${res.status}` };
      } catch (e) {
        return { ok: false, reason: 'error', logs: [], error: (e as Error).message };
      }
    },
  };
}

const REFUSALS: Record<Exclude<AgentSpendResult, { ok: true }>['reason'], string> = {
  policy: "Over the user's limit for this period: the wallet refused it onchain.",
  destination: "The user didn't allow this payee: the wallet refused it onchain.",
  balance: 'The wallet does not have enough balance.',
  revoked: 'The user has not allowed this agent to spend, or revoked it.',
  error: 'The payment could not be completed.',
};

/**
 * The tools a wallet agent's model gets: `pay` (one of the agent's payees by label, or an
 * address) and `wallet_status`. `spend` is `agentSpend` with your agent's key, or
 * `cloudAgents(...).spend` for a Karai Cloud agent. Amounts are in whole tokens for the
 * model and base units onchain (6 decimals, as USDC).
 */
export function walletTools(args: {
  connection: Connection;
  type: AgentType;
  swigAddress: string;
  spend: (to: string, amount: bigint) => Promise<AgentSpendResult>;
  symbol?: string;
}): AgentTool[] {
  const { connection, type, swigAddress } = args;
  const symbol = args.symbol ?? 'USDC';
  const units = (amount: bigint | null) => (amount === null ? null : Number(amount) / 1e6);
  const labelOf = (address: string) => type.destinations.find((d) => d.address === address)?.label ?? address;
  const payees = type.destinations.map((d) => d.label ?? d.address);

  const resolve = (to: string): string | null => {
    const byLabel = type.destinations.find((d) => d.label && d.label.toLowerCase() === to.trim().toLowerCase());
    if (byLabel) return byLabel.address;
    try {
      return new PublicKey(to.trim()).toBase58();
    } catch {
      return null;
    }
  };

  return [
    {
      name: 'pay',
      description: `Pay ${symbol} from the user's wallet. "to" is ${payees.length ? `one of: ${payees.join(', ')}, or ` : ''}a Solana address.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: payees.length ? `A payee name (${payees.join(', ')}) or a Solana address` : 'A Solana address' },
          amount: { type: 'number', description: `Amount in ${symbol}, e.g. 3.5` },
          reason: { type: 'string', description: 'What the payment is for' },
        },
        required: ['to', 'amount'],
      },
      async run(input) {
        const to = resolve(String(input.to ?? ''));
        const amount = Number(input.amount);
        if (!to) return { ok: false, reason: 'invalid_payee', message: 'That is not a payee name or a Solana address.' };
        if (!(amount > 0) || amount > 1_000_000) return { ok: false, reason: 'invalid_amount', message: 'The amount must be positive.' };
        const result = await args.spend(to, BigInt(Math.round(amount * 1e6)));
        return result.ok
          ? { ok: true, paid: amount, symbol, to: labelOf(to), signature: result.signature }
          : {
              ok: false,
              reason: result.reason,
              message: result.reason === 'error' && result.error ? result.error : REFUSALS[result.reason],
              signature: result.signature,
            };
      },
    },
    {
      name: 'wallet_status',
      description: `The user's ${symbol} balance, your limit, what is left of it this period, and who you may pay.`,
      parameters: { type: 'object', properties: {} },
      async run() {
        const swig = await loadSwig(connection, swigAddress);
        const info = listAgents(swig, type.mint).find((a) => a.agent === type.agent);
        const ata = getAssociatedTokenAddressSync(new PublicKey(type.mint), await walletAddressOf(swig), true);
        const balance = await connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount), () => 0n);
        return {
          allowed: !!info,
          balance: units(balance),
          limit_per_period: info ? units(info.maxPerWindow) : 0,
          period: info ? (periodOf(info.windowSlots) ?? 'custom') : null,
          left_this_period: info ? units(info.remaining) : 0,
          may_pay: !info ? [] : info.destinations ? payableBy(info, type.destinations.map((d) => d.address)).map(labelOf) : 'anyone',
          symbol,
        };
      },
    },
  ];
}

export function keypairFromEnv(value: string | undefined, name: string): Keypair {
  if (!value) throw new Error(`Missing ${name}. Run \`pnpm setup:devnet\`.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value) as number[]));
}

function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= max;
  };
}
