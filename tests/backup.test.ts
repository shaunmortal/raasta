import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { gemma } from '../api/_lib';

const claudeReply = (text: string) =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

describe('Claude backup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMMA_WAIT_MS']) delete process.env[k];
  });

  it('answers through Claude when Gemma does not reply in time', async () => {
    Object.assign(process.env, { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', GEMMA_WAIT_MS: '50' });
    const seen: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(new URL(url).host);
      if (url.includes('generativelanguage'))
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return Promise.resolve(claudeReply('{"destination_id":"101"}'));
    });
    const t = Date.now();
    const out = await gemma(z.object({ destination_id: z.string() }), 'q', { timeout: 10_000, signal: new AbortController().signal });
    expect(out).toEqual({ destination_id: '101' });
    expect(seen).toEqual(['generativelanguage.googleapis.com', 'api.anthropic.com']);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
