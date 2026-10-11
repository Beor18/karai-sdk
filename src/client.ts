import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  findSwigPda,
  getAddAuthorityInstructions,
  getCreateSwigInstruction,
  getRemoveAuthorityInstructions,
  getSignInstructions,
} from '@swig-wallet/classic';
import {
  Actions,
  createEd25519AuthorityInfo,
  createSecp256r1AuthorityInfo,
  findSwigSystemAddressPdaRaw,
  type Swig,
} from '@swig-wallet/lib';
import type { AgentType } from './agents';
import { KARAI_CLOUD_URL } from './cloud-url';
import { paymentInstructions, quoteFees, type FeeQuote, type FeeSchedule } from './fees';
import { walletHistory, type HistoryEntry } from './history';
import { createPasskey, discoverPasskey, passkeySigningFn, swigIdFromCredential } from './passkey';
import {
  agentActions,
  agentRole,
  listAgents,
  loadSwig,
  ownerRole,
  walletAddressOf,
  type AgentInfo,
  type AgentPolicy,
} from './swig';

export type KaraiConfig = {
  rpcUrl: string;
  /** Your own relayer, which sponsors fees. See `createRelayHandler` in `@karai/sdk/server`. */
  relayUrl?: string;
  /** Karai Cloud app id: the hosted relayer pays fees instead of your own. */
  appId?: string;
  /** Karai Cloud base URL. Defaults to KARAI_CLOUD_URL. */
  cloudUrl?: string;
  appName?: string;
  /** SPL mints whose token accounts are opened (sponsored) when a wallet is created. */
  tokens?: string[];
  /** WebAuthn relying party id. Defaults to the current hostname. */
  rpId?: string;
};

export type KaraiSession = {
  credentialId: string;
  swigAddress: string;
  /** Address that holds the user's funds. */
  walletAddress: string;
};

type RelayInfo = { feePayer: PublicKey; fees: FeeSchedule | null; agents: AgentType[] };

export class KaraiError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
    readonly signature?: string,
  ) {
    super(message);
    this.name = 'KaraiError';
  }
}

export class KaraiClient {
  readonly connection: Connection;
  readonly relayUrl: string;
  private relayInfo?: Promise<RelayInfo>;
  /** Odometer of the owner's last signature, per swig. */
  private signedOdometer = new Map<string, number>();
  private historyCache = new Map<string, HistoryEntry>();

  constructor(readonly config: KaraiConfig) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    if (config.relayUrl) this.relayUrl = config.relayUrl;
    else if (config.appId) this.relayUrl = `${(config.cloudUrl ?? KARAI_CLOUD_URL).replace(/\/$/, '')}/api/relay/${config.appId}`;
    else throw new KaraiError('Set relayUrl (your own relayer) or appId (Karai Cloud)');
  }

  /** Create a passkey and an onchain wallet owned by it. Fees are sponsored. */
  async createWallet(username: string): Promise<KaraiSession> {
    const passkey = await createPasskey({
      username,
      appName: this.config.appName ?? 'Karai',
      rpId: this.config.rpId,
    });
    const id = await swigIdFromCredential(passkey.credentialId);
    const swigAddress = findSwigPda(id);
    const feePayer = await this.feePayer();

    const ix = await getCreateSwigInstruction({
      payer: feePayer,
      id,
      actions: Actions.set().all().get(),
      authorityInfo: createSecp256r1AuthorityInfo(passkey.publicKey),
    });
    // Open token accounts up front: the wallet is a PDA, and many faucets and
    // wallets refuse to create token accounts for off-curve owners.
    const [systemAddress] = await findSwigSystemAddressPdaRaw(swigAddress);
    const wallet = new PublicKey(systemAddress.toBytes());
    const tokenAccounts = (this.config.tokens ?? []).map((mint) =>
      createAssociatedTokenAccountIdempotentInstruction(
        feePayer,
        getAssociatedTokenAddressSync(new PublicKey(mint), wallet, true),
        wallet,
        new PublicKey(mint),
      ),
    );
    await this.sendSponsored([ix, ...tokenAccounts]);
    return this.sessionFor(passkey.credentialId, swigAddress);
  }

  /** Sign in with an existing passkey (works on any device the passkey is synced to). */
  async login(): Promise<KaraiSession> {
    const credentialId = await discoverPasskey(this.config.rpId);
    const swigAddress = findSwigPda(await swigIdFromCredential(credentialId));
    const exists = await this.connection.getAccountInfo(swigAddress);
    if (!exists) throw new KaraiError('This passkey has no Karai wallet yet');
    return this.sessionFor(credentialId, swigAddress);
  }

  async tokenBalance(session: KaraiSession, mint: string): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(session.walletAddress), true);
    try {
      const balance = await this.connection.getTokenAccountBalance(ata);
      return BigInt(balance.value.amount);
    } catch (e) {
      // No token account yet means a zero balance; an RPC error is not a zero balance.
      if (/could not find account/i.test((e as Error).message ?? '')) return 0n;
      throw e;
    }
  }

  /**
   * Send SPL tokens, signed with the user's passkey. The user needs no SOL.
   * Platform fees set on the relayer travel in the same signed transaction.
   */
  async transferToken(
    session: KaraiSession,
    args: { mint: string; to: string; amount: bigint },
  ): Promise<string> {
    const { feePayer, fees } = await this.info();
    let payment: ReturnType<typeof paymentInstructions>;
    try {
      payment = paymentInstructions({
        schedule: fees,
        mint: new PublicKey(args.mint),
        wallet: new PublicKey(session.walletAddress),
        to: new PublicKey(args.to),
        amount: args.amount,
        payer: feePayer,
      });
    } catch (e) {
      throw new KaraiError((e as Error).message);
    }
    // Opening a token account that already exists only makes the transaction bigger.
    const existing = await this.connection.getMultipleAccountsInfo(payment.accounts, 'confirmed').catch(() => []);
    const pre = payment.pre.filter((_, i) => !existing[i]);
    return this.signAsOwner(session, (swig, roleId, options) => getSignInstructions(swig, roleId, payment.inner, false, options), pre);
  }

  /** Platform fees the relayer charges on payments, or null if it charges none. */
  async fees(): Promise<FeeSchedule | null> {
    return (await this.info()).fees;
  }

  /** What a payment costs and who receives what, to show before the user signs. */
  async quote(mint: string, amount: bigint): Promise<FeeQuote> {
    return quoteFees(await this.fees(), mint, amount);
  }

  /** Agents this app offers, as its relayer publishes them. */
  async agentTypes(): Promise<AgentType[]> {
    return (await this.info()).agents;
  }

  /**
   * Let an agent spend up to `maxPerWindow` of one token. Enforced by the Swig program.
   * With destinations, the relayer's fee recipients are allowed too, so the agent's
   * payments can carry their fees.
   */
  async grantAgent(session: KaraiSession, policy: AgentPolicy): Promise<string> {
    const { fees } = await this.info();
    const feeRecipients = policy.destinations?.length && fees?.mint === policy.mint ? fees.rules.map((r) => r.recipient) : [];
    const destinations = policy.destinations ? [...policy.destinations, ...feeRecipients] : undefined;
    return this.signAsOwner(session, (swig, roleId, options) =>
      getAddAuthorityInstructions(
        swig,
        roleId,
        createEd25519AuthorityInfo(new PublicKey(policy.agent)),
        agentActions({ ...policy, destinations }),
        options,
      ),
    );
  }

  async revokeAgent(session: KaraiSession, agent: string): Promise<string> {
    return this.signAsOwner(session, (swig, roleId, options) => {
      const role = agentRole(swig, agent);
      if (!role) throw new KaraiError('That agent has no permissions on this wallet');
      return getRemoveAuthorityInstructions(swig, roleId, role.id, options);
    });
  }

  /** Activity rebuilt from the chain, newest first. Works on any device. */
  async history(session: KaraiSession, mint: string, limit = 25): Promise<HistoryEntry[]> {
    return walletHistory(this.connection, { ...session, mint, limit }, this.historyCache);
  }

  async agents(session: KaraiSession, mint: string): Promise<AgentInfo[]> {
    return listAgents(await loadSwig(this.connection, session.swigAddress), mint);
  }

  private async sessionFor(credentialId: string, swigAddress: PublicKey): Promise<KaraiSession> {
    const swig = await loadSwig(this.connection, swigAddress);
    return {
      credentialId,
      swigAddress: swigAddress.toBase58(),
      walletAddress: (await walletAddressOf(swig)).toBase58(),
    };
  }

  /** Fee payer, fee schedule and agent types, fetched once from the relayer. */
  private info() {
    this.relayInfo ??= fetch(this.relayUrl)
      .then(async (res) => {
        if (!res.ok) throw new KaraiError('Relay is unavailable');
        const body = (await res.json()) as { feePayer: string; fees?: FeeSchedule | null; agents?: AgentType[] };
        return { feePayer: new PublicKey(body.feePayer), fees: body.fees ?? null, agents: body.agents ?? [] };
      })
      .catch((e: unknown) => {
        this.relayInfo = undefined; // retry on the next call
        throw e;
      });
    return this.relayInfo;
  }

  private async feePayer(): Promise<PublicKey> {
    return (await this.info()).feePayer;
  }

  /**
   * Build owner-signed Swig instructions and relay them. The swig is re-fetched
   * right before signing: secp256r1 signatures carry an odometer that must be
   * the next value onchain, and a fresh slot for replay protection.
   */
  private async signAsOwner(
    session: KaraiSession,
    build: (
      swig: Swig,
      roleId: number,
      options: Parameters<typeof getSignInstructions>[4],
    ) => Promise<TransactionInstruction[]>,
    preInstructions: TransactionInstruction[] = [],
  ): Promise<string> {
    const swig = await this.freshSwig(session.swigAddress);
    const odometer = odometerOf(swig);
    const feePayer = await this.feePayer();
    // A signature in Swig's raw clientDataJSON form (see passkeySigningFn) can push a
    // large transaction past Solana's size limit. Nothing was sent, so ask again:
    // the next assertion usually fits the compact form.
    for (let attempt = 1; ; attempt++) {
      const ixs = await build(swig, ownerRole(swig).id, {
        signingFn: passkeySigningFn(session.credentialId, this.config.rpId),
        currentSlot: BigInt(await this.connection.getSlot('confirmed')),
        payer: feePayer,
      });
      const instructions = [...preInstructions, ...ixs];
      if (!fitsInTransaction(feePayer, instructions)) {
        if (attempt < MAX_SIGN_ATTEMPTS) continue;
        throw new KaraiError('This transaction is too large for a passkey signature');
      }
      const signature = await this.sendSponsored(instructions);
      if (odometer !== null) this.signedOdometer.set(session.swigAddress, odometer);
      return signature;
    }
  }

  /**
   * The swig as it is after our last signature. Load-balanced RPCs can serve state
   * from before a transaction we just confirmed; signing over that stale odometer
   * makes Swig reject the next transaction, so wait until the chain catches up.
   */
  private async freshSwig(address: string): Promise<Swig> {
    const last = this.signedOdometer.get(address);
    for (let attempt = 0; ; attempt++) {
      const swig = await loadSwig(this.connection, address);
      const next = odometerOf(swig);
      if (last === undefined || next === null || next > last || attempt >= 15) return swig;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private async sendSponsored(instructions: TransactionInstruction[]): Promise<string> {
    const feePayer = await this.feePayer();
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(...instructions);
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    const res = await fetch(this.relayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: toBase64(serialized) }),
    });
    const body = (await res.json()) as { signature?: string; error?: string; logs?: string[] };
    if (!res.ok || !body.signature) {
      throw new KaraiError(body.error ?? 'Relay rejected the transaction', body.logs, body.signature);
    }
    return body.signature;
  }
}

const MAX_SIGN_ATTEMPTS = 3;

/** Whether the instructions fit in one legacy transaction (1232 bytes). */
function fitsInTransaction(feePayer: PublicKey, instructions: TransactionInstruction[]): boolean {
  try {
    new Transaction({ feePayer, recentBlockhash: PublicKey.default.toBase58() })
      .add(...instructions)
      .serialize({ requireAllSignatures: false, verifySignatures: false });
    return true;
  } catch {
    return false;
  }
}

/** The odometer the owner's next passkey signature will carry, if the authority has one. */
function odometerOf(swig: Swig): number | null {
  const { authority } = ownerRole(swig);
  return 'odometer' in authority && typeof authority.odometer === 'function' ? (authority as { odometer(): number }).odometer() : null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
