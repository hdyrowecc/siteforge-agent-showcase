import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveModel } from '../src/provider.mjs';

const options = { apiKey: 'fixture-key', model: 'fixture-model' };
const response = data => ({ ok: true, status: 200, json: async () => data });

test('live adapter sends a bounded structured request and parses tool calls', async () => {
  let seen;
  const model = createLiveModel({ ...options, fetchImpl: async (url, init) => {
    seen = { url: String(url), init };
    return response({ choices: [{ message: {
      content: 'Check the fixture',
      tool_calls: [{ id: 'call-1', function: {
        name: 'read_project_file', arguments: '{"path":"index.html"}'
      } }]
    } }] });
  } });
  const result = await model.next([{ role: 'user', content: 'Test' }], []);
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(seen.init.body), {
    model: 'fixture-model', messages: [{ role: 'user', content: 'Test' }],
    tools: [], tool_choice: 'auto', temperature: 0
  });
  assert.equal(seen.init.signal.aborted, false);
  assert.deepEqual(result, {
    text: 'Check the fixture', toolCalls: [{
      id: 'call-1', name: 'read_project_file', args: { path: 'index.html' }
    }]
  });
});

test('malformed model tool argument JSON stays invalid for the runtime to reject', async () => {
  const model = createLiveModel({ ...options, fetchImpl: async () => response({
    choices: [{ message: { content: null, tool_calls: [{
      id: 'bad-1', function: { name: 'replace_in_file', arguments: '{not json' }
    }] } }]
  }) });
  const result = await model.next([], []);
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, [{
    id: 'bad-1', name: 'replace_in_file', args: null
  }]);
});

test('HTTP errors, invalid JSON, and empty choices are surfaced without raw response bodies', async () => {
  const notFound = createLiveModel({ ...options,
    fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(notFound.next([], []), /LLM_HTTP_429/);

  const invalidJson = createLiveModel({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid fixture'); } }) });
  await assert.rejects(invalidJson.next([], []), SyntaxError);

  const missing = createLiveModel({ ...options,
    fetchImpl: async () => response({ choices: [] }) });
  await assert.rejects(missing.next([], []), /Missing LLM response message/);
});

test('provider enforces its own deadline even when the caller supplies a live signal', async () => {
  const controller = new AbortController();
  let observedSignal;
  const model = createLiveModel({ ...options, timeoutMs: 20,
    fetchImpl: (_, init) => {
      observedSignal = init.signal;
      return new Promise((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
  });
  await assert.rejects(model.next([], [], { signal: controller.signal }),
    error => error?.name === 'TimeoutError');
  assert.equal(controller.signal.aborted, false);
  assert.equal(observedSignal.aborted, true);
});

test('caller cancellation is propagated through the composed transport signal', async () => {
  const controller = new AbortController();
  const model = createLiveModel({ ...options,
    fetchImpl: (_, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })
  });
  const pending = model.next([], [], { signal: controller.signal });
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
});

test('invalid live model configuration is rejected before any network call', () => {
  assert.throws(() => createLiveModel({ model: 'fixture', apiKey: '' }), /OPENAI_API_KEY/);
  assert.throws(() => createLiveModel({ ...options, baseUrl: 'http://example.org/v1' }), /HTTPS/);
  assert.throws(() => createLiveModel({ ...options, timeoutMs: 0 }), RangeError);
  assert.throws(() => createLiveModel({ ...options, fetchImpl: null }), TypeError);
});
