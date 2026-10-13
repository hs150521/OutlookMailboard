const assert = require('node:assert/strict');
const test = require('node:test');
const { createMailClient } = require('../src/mail');

test('Graph refresh reads inbox and junk with text content', async () => {
  const calls = [];
  const client = createMailClient({
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.includes('/token')) return new Response(JSON.stringify({
        access_token: 'access-token', refresh_token: 'new-refresh-token',
        scope: 'https://graph.microsoft.com/Mail.Read',
      }), { status: 200 });
      return new Response(JSON.stringify({ value: url.includes('/inbox/') ? [{
        id: 'message-one', from: { emailAddress: { address: 'sender@example.net' } },
        subject: 'Your code', bodyPreview: '123456', body: { content: 'Code: 123456' },
        receivedDateTime: '2026-10-10T10:00:00Z',
      }] : [] }), { status: 200 });
    },
  });
  const result = await client.fetchMessages({
    email: 'one@outlook.com', client_id: 'client', refresh_token: 'old-token',
  });
  assert.equal(result.method, 'graph');
  assert.equal(result.refreshToken, 'new-refresh-token');
  assert.equal(result.folders.inbox[0].bodyText, 'Code: 123456');
  assert.deepEqual(result.folders.junk, []);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body.get('refresh_token'), 'old-token');
});
