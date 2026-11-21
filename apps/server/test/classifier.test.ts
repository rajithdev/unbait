import { describe, expect, test, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClassifierError, SYSTEM_PROMPT, createClaudeClassifier, tidyReason } from '../src/classifier.js';

const usage = { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };

function fakeClient(response: unknown) {
  const parse = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe('Claude classifier', () => {
  test('sends a cached system prompt, positional ids and structured output', async () => {
    const { client, parse } = fakeClient({
      stop_reason: 'end_turn',
      usage,
      parsed_output: { results: [{ id: 'p2', category: 'hype_listicle', reason: '"A hype list."' }, { id: 'p1', category: 'none', reason: 'whatever' }] },
    });
    const c = createClaudeClassifier({ client, model: 'claude-opus-5-5', effort: 'low' });
    const { results, usage: u } = await c.classify([
      { id: 'hash-a', text: 'first' },
      { id: 'hash-b', text: 'second' },
    ]);
    expect(results.get('hash-a')).toEqual({ verdict: 'none', reason: '' });
    expect(results.get('hash-b')).toEqual({ verdict: 'hype_listicle', reason: 'A hype list' });
    expect(u).toEqual({ inputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 80 });

    const params = (parse.mock.calls[0] as any)[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.system[0]).toMatchObject({ text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } });
    expect(params.output_config.effort).toBe('low');
    expect(params.output_config.format).toBeTruthy();
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.messages[0].content).toContain('"id":"p1","text":"first"');
    expect(params.messages[0].content).not.toContain('hash-a');
  });

  test('models without server-side fallback get no fallbacks parameter', async () => {
    const { client, parse } = fakeClient({ stop_reason: 'end_turn', usage, parsed_output: { results: [] } });
    await createClaudeClassifier({ client, model: 'claude-haiku-5-5', effort: 'low' }).classify([{ id: 'x', text: 'y' }]);
    const params = (parse.mock.calls[0] as any)[0];
    expect(params.fallbacks).toBeUndefined();
    expect(params.betas).toBeUndefined();
  });

  test.each([
    [{ stop_reason: 'refusal', usage, parsed_output: null }, false],
    [{ stop_reason: 'max_tokens', usage, parsed_output: null }, true],
    [{ stop_reason: 'end_turn', usage, parsed_output: null }, true],
  ])('turns a bad response into a ClassifierError (%#)', async (response, retryable) => {
    const { client } = fakeClient(response);
    const err = await createClaudeClassifier({ client, model: 'claude-opus-5-5', effort: 'low' }).classify([{ id: 'x', text: 'y' }]).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err.retryable).toBe(retryable);
  });

  test('turns network errors into a retryable ClassifierError', async () => {
    const { client } = fakeClient(new Error('socket hang up'));
    const err = await createClaudeClassifier({ client, model: 'claude-opus-5-5', effort: 'low' }).classify([{ id: 'x', text: 'y' }]).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err.retryable).toBe(true);
  });

  test('the system prompt is stable and long enough to cache', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Prompt caching needs at least 512 tokens; ~4 characters per token.
    expect(SYSTEM_PROMPT.length / 4).toBeGreaterThan(600);
  });

  test('reasons are trimmed to one short line', () => {
    expect(tidyReason('  "Asks you\nto comment."  ')).toBe('Asks you to comment');
    expect(tidyReason(Array(20).fill('word').join(' ')).split(' ')).toHaveLength(14);
  });
});
