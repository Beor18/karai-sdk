import type { AiProvider } from './ai';

export type ModelPreset = {
  id: string;
  label: string;
  provider: AiProvider;
  /** Suggested model id; the developer can type any other. */
  model: string;
  baseUrl?: string;
};

/** Starting points for picking an agent's model. Model ids change often: any id the provider accepts works. */
export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'claude', label: 'Claude (Anthropic)', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { id: 'gpt', label: 'GPT (OpenAI)', provider: 'openai', model: 'gpt-6-luna' },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    provider: 'openai-compatible',
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { id: 'compatible', label: 'Other OpenAI-compatible', provider: 'openai-compatible', model: '', baseUrl: '' },
];
