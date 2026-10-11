# Karai SDK

**Wallets that belong to your users.** Passkey wallets on Solana for your app, with budgets for AI agents.

- **Passkey:** sign in with Face ID. No seed.
- **Non-custodial:** each wallet is a [Swig](https://github.com/anagrambuild/swig-wallet) smart wallet that only the user's passkey controls.
- **Gasless:** a relayer pays the fees. Users never need SOL.
- **AI agents:** your app picks the AI; the user signs a budget (amount per day/week/month, and who it may pay). Anything outside it, the wallet refuses onchain.

Live demo and guide: [karai-beige.vercel.app](https://karai-beige.vercel.app/demo) · [docs](https://karai-beige.vercel.app/docs)

> **Español.** Wallets con passkey en Solana para tu app: entran con Face ID, sin seed y sin SOL, y solo su passkey las controla. Los agentes de IA gastan dentro del presupuesto que firmó el usuario; si intentan pasarse o pagarle a otro, la wallet lo rechaza. Guía completa en español en [/docs](https://karai-beige.vercel.app/docs).

## Install

```bash
pnpm add github:Beor18/karai-sdk @solana/web3.js @solana/spl-token
```

Not on npm yet. It ships TypeScript: in Next.js, add `transpilePackages: ["@karai/sdk"]` to `next.config`. Passkeys need HTTPS or localhost.

## Quickstart

```tsx
import { KaraiProvider, LoginButton } from "@karai/sdk/react";

<KaraiProvider config={{ rpcUrl, relayUrl: "/api/relay" }}>   {/* or appId: "app_…" with Karai Cloud */}
  <LoginButton />
</KaraiProvider>
```

```ts
const { client, session } = useKarai();
if (!session) return;                                                         // signed out: show <LoginButton />
await client.transferToken(session, { mint: USDC, to, amount: 5_000_000n }); // signed with the passkey, gas paid
const [agent] = await client.agentTypes();                                   // the agents your app offers
await client.grantAgent(session, agentPolicy(agent, 20_000_000n));            // 20 USDC/day, only to its payees
```

Your own relayer is one line on your server:

```ts
// app/api/relay/route.ts
import { createRelayHandler } from "@karai/sdk/server";

export const { GET, POST } = createRelayHandler({ connection, feePayer, fees, agents });
```

It co-signs only allowlisted programs, as the only signer, when simulation shows the fee payer loses at most 0.01 SOL (CPI inside Swig included).

The agent's AI runs where you want, on your key: `runAgent` speaks Claude, GPT and any Chat Completions API, and `walletTools` gives any agent framework `pay` and `wallet_status`. `agentSpend` lets your server spend within the user's budget.

## Karai Cloud

Don't want to run a relayer? [Karai Cloud](https://karai-beige.vercel.app/dashboard) hosts it: create an app, paste its `appId` in `KaraiProvider`, and define agents and their model in the dashboard. Call them from your server with `cloudAgents({ appId, apiKey })`.

## Status

Devnet only. Not yet: role expiry, a second passkey for recovery, mainnet.

[MIT](LICENSE)
