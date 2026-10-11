import type { AiProvider } from './ai';
import { SLOTS_PER_DAY, tokenAccountOf, type AgentInfo, type AgentPolicy } from './swig';

export type AgentPeriod = 'day' | 'week' | 'month';

export const PERIOD_SLOTS: Record<AgentPeriod, bigint> = {
  day: SLOTS_PER_DAY,
  week: SLOTS_PER_DAY * 7n,
  month: SLOTS_PER_DAY * 30n,
};

/**
 * An agent your app offers its users, published by your relayer. You define what it
 * is for and who it may pay; each user decides whether to allow it and how much.
 */
export type AgentType = {
  id: string;
  /** Shown to the user, e.g. "Shopping agent". */
  name: string;
  description?: string;
  /** The agent's ed25519 public key. Its private key stays on your server (or in Karai Cloud). */
  agent: string;
  /** The token it spends. */
  mint: string;
  /** Suggested limit per period, in base units, as a string (JSON has no bigint). */
  limit: string;
  period: AgentPeriod;
  /** Wallets it may pay. Empty: any. */
  destinations: { address: string; label?: string }[];
  /** The AI model that decides when it pays, if the app runs one for it (never the key). */
  model?: { provider: AiProvider; model: string } | null;
};

/** The policy a user signs to allow an agent type, with their own limit if they set one. */
export function agentPolicy(type: AgentType, maxPerWindow = BigInt(type.limit)): AgentPolicy {
  return {
    agent: type.agent,
    mint: type.mint,
    maxPerWindow,
    windowSlots: PERIOD_SLOTS[type.period],
    destinations: type.destinations.length ? type.destinations.map((d) => d.address) : undefined,
  };
}

/** Which of `owners` a granted agent may pay (all of them if it has no destination list). */
export function payableBy(info: AgentInfo, owners: string[]): string[] {
  if (!info.destinations) return owners;
  const allowed = new Set(info.destinations);
  return owners.filter((owner) => allowed.has(tokenAccountOf(info.mint, owner)));
}

/** The period that matches a granted window, if it is one of ours. */
export function periodOf(windowSlots: bigint | null): AgentPeriod | null {
  const match = Object.entries(PERIOD_SLOTS).find(([, slots]) => slots === windowSlots);
  return match ? (match[0] as AgentPeriod) : null;
}
