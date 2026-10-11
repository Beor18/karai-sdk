import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { fetchSwig, getSwigWalletAddress } from '@swig-wallet/classic';
import {
  Actions,
  isEd25519BasedAuthority,
  isSecp256r1BasedAuthority,
  type Role,
  type Swig,
} from '@swig-wallet/lib';

// Swig's Permission enum values. The lib re-exports the enum from a CommonJS build,
// which Node's ESM loader can't see, so the values live here.
const TOKEN_DESTINATION_LIMIT = 18;
const TOKEN_RECURRING_DESTINATION_LIMIT = 19;

/** ~24h at 400ms slots. Swig recurring limits are measured in slots. */
export const SLOTS_PER_DAY = 216_000n;

export type AgentPolicy = {
  /** Agent's ed25519 public key. */
  agent: string;
  /** SPL mint the agent is allowed to spend. */
  mint: string;
  /** Max spend per window, in base units (e.g. 20 USDC = 20_000_000n). */
  maxPerWindow: bigint;
  /** Window length in slots. Defaults to one day. */
  windowSlots?: bigint;
  /**
   * Wallets the agent may pay. Omit to allow any. Swig rejects a transfer to any
   * other token account, so a hijacked agent can't send funds to itself.
   */
  destinations?: string[];
};

export type AgentInfo = {
  agent: string;
  roleId: number;
  mint: string;
  maxPerWindow: bigint | null;
  remaining: bigint | null;
  windowSlots: bigint | null;
  /** Token accounts the agent may pay, or null if it may pay any. */
  destinations: string[] | null;
};

export async function loadSwig(connection: Connection, swigAddress: string | PublicKey): Promise<Swig> {
  return fetchSwig(connection, new PublicKey(swigAddress), { commitment: 'confirmed' });
}

export async function walletAddressOf(swig: Swig): Promise<PublicKey> {
  return getSwigWalletAddress(swig);
}

/** The owner is the passkey (secp256r1) role. */
export function ownerRole(swig: Swig): Role {
  const role = swig.roles.find((r) => isSecp256r1BasedAuthority(r.authority));
  if (!role) throw new Error('This wallet has no passkey owner');
  return role;
}

export function agentRole(swig: Swig, agent: string | PublicKey): Role | null {
  return swig.findRolesByAuthoritySigner(new PublicKey(agent).toBytes())[0] ?? null;
}

/** A destination limit that never runs out: it only marks the account as allowed. */
const UNCAPPED = 2n ** 64n - 1n;

/**
 * Agents may move one token, up to a recurring limit, through the token program only.
 * With destinations, Swig also matches every transfer to a destination action and
 * refuses any account without one. Those actions are uncapped, so the recurring limit
 * (listed first, which is the one `tokenSpend` reports) stays the only cap, and the
 * smaller action keeps the passkey-signed grant within Solana's transaction size.
 */
export function agentActions(policy: AgentPolicy): Actions {
  const mint = new PublicKey(policy.mint);
  const window = policy.windowSlots ?? SLOTS_PER_DAY;
  const actions = Actions.set().tokenRecurringLimit({ mint, recurringAmount: policy.maxPerWindow, window });
  const accounts = new Set((policy.destinations ?? []).map((owner) => tokenAccountOf(policy.mint, owner)));
  for (const destination of accounts) {
    actions.tokenDestinationLimit({ mint, amount: UNCAPPED, destination: new PublicKey(destination) });
  }
  return actions.programLimit({ programId: TOKEN_PROGRAM_ID }).get();
}

/** The token account a payment to `owner` lands in. */
export function tokenAccountOf(mint: string, owner: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58();
}

export function listAgents(swig: Swig, mint: string): AgentInfo[] {
  return swig.roles.flatMap((role) => {
    if (!isEd25519BasedAuthority(role.authority)) return [];
    const spend = role.actions.tokenSpend(new PublicKey(mint));
    const destinations = destinationsOf(role, mint);
    return [
      {
        agent: new PublicKey(role.authority.ed25519PublicKey.toBytes()).toBase58(),
        roleId: role.id,
        mint,
        maxPerWindow: spend.recurringLimit ?? spend.spendLimit,
        remaining: spend.spendLimit,
        windowSlots: spend.window,
        destinations: destinations.length ? destinations : null,
      },
    ];
  });
}

function destinationsOf(role: Role, mint: string): string[] {
  // The lib keeps decoded actions on a private field; the raw bytes are the only public view.
  type DecodedAction = { permission: number; payload: { data?: { mint: Uint8Array; destination: Uint8Array } } };
  const actions = (role.actions as unknown as { actions?: DecodedAction[] }).actions ?? [];
  return actions.flatMap(({ permission, payload }) => {
    if (permission !== TOKEN_DESTINATION_LIMIT && permission !== TOKEN_RECURRING_DESTINATION_LIMIT) return [];
    const data = payload.data;
    return data && new PublicKey(data.mint).toBase58() === mint ? [new PublicKey(data.destination).toBase58()] : [];
  });
}
