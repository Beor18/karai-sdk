import type { AgentType } from './agents';

/**
 * The model behind an agent. The developer picks it and pays for it with their own key;
 * Karai only hands the model its wallet tools, and the user's wallet decides every payment.
 * - anthropic: Claude, through the Messages API.
 * - openai: GPT, through the Responses API (what current GPT models need for tools).
 * - openai-compatible: any Chat Completions API (Gemini, OpenRouter, Groq, a local model…).
 */
export type AiProvider = 'anthropic' | 'openai' | 'openai-compatible';

export type AiModel = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Override the API root, e.g. a gateway. Required for openai-compatible. */
  baseUrl?: string;
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type AgentStep = { tool: string; args: Record<string, unknown>; result: unknown };
export type AgentRun = { reply: string; steps: AgentStep[] };

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

const DEFAULT_BASE_URL: Record<Exclude<AiProvider, 'openai-compatible'>, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Turn = { text: string; calls: ToolCall[] };
/** One conversation with a provider, kept in its own message format. */
type Session = { next(): Promise<Turn>; answer(results: (ToolCall & { result: unknown })[]): void };

/**
 * Run one user turn: the model may call tools a few times, then replies.
 * The conversation is stateless here: pass the previous text turns in `messages`.
 */
export async function runAgent(args: {
  model: AiModel;
  instructions: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  maxSteps?: number;
}): Promise<AgentRun> {
  const open = { anthropic: anthropicSession, openai: responsesSession, 'openai-compatible': chatCompletionsSession }[args.model.provider];
  if (!open) throw new AiError(`Unknown provider: ${args.model.provider}`);
  const session = open(args.model, args.instructions, args.messages, args.tools);
  const steps: AgentStep[] = [];
  let reply = '';
  for (let step = 0; step < (args.maxSteps ?? 4); step++) {
    const turn = await session.next();
    reply = turn.text || reply;
    if (turn.calls.length === 0) return { reply, steps };
    const results = [];
    for (const call of turn.calls) {
      const tool = args.tools.find((t) => t.name === call.name);
      const result = tool
        ? await tool.run(call.args).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
        : { error: `Unknown tool ${call.name}` };
      steps.push({ tool: call.name, args: call.args, result });
      results.push({ ...call, result });
    }
    session.answer(results);
  }
  return { reply, steps };
}

/** A one-line request to check that the model, key and endpoint work. */
export async function pingModel(model: AiModel): Promise<string> {
  const run = await runAgent({ model, instructions: 'Reply with the single word: OK', messages: [{ role: 'user', content: 'ping' }], tools: [] });
  return run.reply;
}

function anthropicSession(m: AiModel, system: string, history: ChatMessage[], tools: AgentTool[]): Session {
  const messages: { role: string; content: unknown }[] = history.map((h) => ({ role: h.role, content: h.content }));
  return {
    async next() {
      const res = await post(`${baseUrl(m)}/messages`, { 'x-api-key': m.apiKey, 'anthropic-version': '2023-06-01' }, {
        model: m.model,
        max_tokens: 4096,
        system,
        messages,
        ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      });
      const content = (res.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      // The assistant turn goes back verbatim, thinking blocks included, as tool use requires.
      messages.push({ role: 'assistant', content });
      return {
        text: content.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join(''),
        calls: content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id!, name: b.name!, args: b.input ?? {} }] : [])),
      };
    },
    answer(results) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) })),
      });
    },
  };
}

function responsesSession(m: AiModel, instructions: string, history: ChatMessage[], tools: AgentTool[]): Session {
  // previous_response_id keeps the model's own items (reasoning included) on OpenAI's side.
  let previous: string | undefined;
  let input: unknown[] = history.map((h) => ({ role: h.role, content: h.content }));
  return {
    async next() {
      const res = await post(`${baseUrl(m)}/responses`, { authorization: `Bearer ${m.apiKey}` }, {
        model: m.model,
        instructions,
        input,
        ...(previous ? { previous_response_id: previous } : {}),
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) } : {}),
      });
      previous = res.id as string;
      const output = (res.output ?? []) as { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }[];
      return {
        text: output.flatMap((o) => (o.type === 'message' ? (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '') : [])).join(''),
        calls: output.flatMap((o) => (o.type === 'function_call' ? [{ id: o.call_id!, name: o.name!, args: parseArgs(o.arguments) }] : [])),
      };
    },
    answer(results) {
      input = results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.result) }));
    },
  };
}

function chatCompletionsSession(m: AiModel, system: string, history: ChatMessage[], tools: AgentTool[]): Session {
  if (!m.baseUrl) throw new AiError('openai-compatible needs a baseUrl');
  const messages: Record<string, unknown>[] = [{ role: 'system', content: system }, ...history];
  return {
    async next() {
      const res = await post(`${baseUrl(m)}/chat/completions`, { authorization: `Bearer ${m.apiKey}` }, {
        model: m.model,
        messages,
        ...(tools.length
          ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      });
      const message = (res.choices?.[0]?.message ?? { role: 'assistant', content: '' }) as {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
      };
      // Verbatim, so provider extras (e.g. Gemini's thought signatures) survive.
      messages.push(message as Record<string, unknown>);
      return {
        text: typeof message.content === 'string' ? message.content : '',
        calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
      };
    },
    answer(results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) });
    },
  };
}

function baseUrl(m: AiModel): string {
  return (m.baseUrl || DEFAULT_BASE_URL[m.provider as keyof typeof DEFAULT_BASE_URL] || '').replace(/\/$/, '');
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider JSON
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    throw new AiError(`Model unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: { error?: { message?: string } | string } & Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // keep the raw text for the error below
  }
  if (!res.ok) {
    const detail = typeof json.error === 'string' ? json.error : (json.error?.message ?? text.slice(0, 200));
    throw new AiError(`Model error ${res.status}: ${detail}`, res.status);
  }
  return json;
}

/** What the agent needs to know about its own wallet and rules, appended to the developer's instructions. */
export function agentSystemPrompt(type: AgentType, instructions: string, symbol = 'USDC'): string {
  const payees = type.destinations.length
    ? `It may only pay: ${type.destinations.map((d) => d.label ?? d.address).join(', ')}.`
    : 'It may pay any address.';
  return [
    instructions.trim(),
    `You are "${type.name}"${type.description ? `: ${type.description}` : ''}. You act for one user and pay from their wallet with the pay tool, in ${symbol}.`,
    `The user gave you a spending limit. ${payees} The wallet enforces the limit and the payees onchain, so a payment may be refused; if it is, tell the user why in one sentence instead of trying other amounts or payees.`,
    'Use wallet_status when you need the balance or what is left of the limit. Reply in the language the user writes in, briefly.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
