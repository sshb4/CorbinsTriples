import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import twilio from 'twilio';
import { incoming, handleRequest, recordEvents, dispatch, poll } from '../src/worker.js';
import { tripleEvents } from '../src/triples.js';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  function prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; }
    };
  }
  return {
    DB: { prepare, async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    } },
    sqlite, MAX_SUBSCRIBERS: '100', MAX_ALERTS_PER_MONTH: '1000',
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'test-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'b'.repeat(32), TWILIO_PHONE_NUMBER: '+18005550199',
    PUBLIC_URL: 'https://alerts.example.com', SUPPORT_EMAIL: 'test@example.com'
  };
}
const phone = '+12025550123';
const message = (Body, more = {}) => ({ From: phone, FromCountry: 'US', Body, ...more });
const row = env => env.sqlite.prepare('SELECT * FROM subscribers WHERE phone=?').get(phone);
async function join(env, now = Date.now() - 1000, number = phone) {
  await incoming(env, message('TRIPLES', { From: number }), now - 1000);
  await incoming(env, message('YES', { From: number }), now);
}
const fixture = JSON.parse(readFileSync(new URL('./triple.fixture.json', import.meta.url)));
const occurred = Date.parse(fixture.liveData.plays.allPlays[0].about.endTime);
const event = { id: 'game:1', occurredAt: Date.now(), body: 'Corbin Triples: HE HIT ONE. Reply STOP to quit.' };

function signedRequest(env, params, path = '/sms') {
  const url = env.PUBLIC_URL + path;
  params = { AccountSid: env.TWILIO_ACCOUNT_SID, To: env.TWILIO_PHONE_NUMBER, MessageSid: 'SM' + 'c'.repeat(32), ...params };
  return new Request(url, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params)
  }, body: new URLSearchParams(params) });
}

test('real MLB triple: identifies batter, game and inning; skips old and incomplete plays', () => {
  const events = tripleEvents(fixture, occurred - 1000, occurred + 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, '778429:0');
  assert.match(events[0].body, /Nationals, inning 1/);
  assert.ok(events[0].body.length <= 160);
  assert.deepEqual(tripleEvents(fixture, occurred, occurred + 1000), []);
  assert.deepEqual(tripleEvents(fixture, 0, occurred + 7 * 60 * 60 * 1000), []);
  for (const mutation of [p => p.result.eventType = 'double', p => p.matchup.batter.id = 1, p => p.about.isComplete = false]) {
    const copy = structuredClone(fixture); mutation(copy.liveData.plays.allPlays[0]);
    assert.deepEqual(tripleEvents(copy, 0, occurred + 1000), []);
  }
});

test('two triples in one game remain distinct; postseason is excluded', () => {
  const copy = structuredClone(fixture);
  const play = structuredClone(copy.liveData.plays.allPlays[0]); play.about.atBatIndex = 20;
  copy.liveData.plays.allPlays.push(play);
  assert.equal(new Set(tripleEvents(copy, 0, occurred + 1000).map(e => e.id)).size, 2);
  copy.gameData.game.type = 'P';
  assert.deepEqual(tripleEvents(copy, 0, occurred + 1000), []);
});

test('subscription requires YES, expires after 15 minutes, and rejects non-US signups', async () => {
  const env = setup();
  await incoming(env, message('YES'), 10000); assert.equal(row(env), undefined);
  await incoming(env, message('TRIPLES'), 10000); assert.equal(row(env).status, 'pending');
  await incoming(env, message('YES'), 10000 + 16 * 60000); assert.equal(row(env).status, 'pending');
  await incoming(env, message('TRIPLES'), 10000 + 17 * 60000);
  await incoming(env, message('YES'), 10000 + 18 * 60000); assert.equal(row(env).status, 'active');
  const other = setup(); await incoming(other, message('TRIPLES', { FromCountry: 'CA' }));
  assert.equal(row(other), undefined);
});

test('capacity applies at confirmation, and repeated requests do not spam replies', async () => {
  const env = setup(); env.MAX_SUBSCRIBERS = '1';
  await join(env);
  const second = message('TRIPLES', { From: '+12025550124' });
  await incoming(env, second);
  assert.equal(await incoming(env, second), '');
  assert.match(await incoming(env, { ...second, Body: 'YES' }), /full/);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) n FROM subscribers WHERE status='active'").get().n, 1);
});

test('STOP cancels pending alerts, and START or stale YES cannot silently re-enroll', async () => {
  const env = setup(); await join(env); await recordEvents(env, [event]);
  assert.equal(await incoming(env, message('STOP', { OptOutType: 'STOP' })), '');
  assert.equal(row(env).status, 'stopped');
  assert.equal(env.sqlite.prepare('SELECT state FROM deliveries').get().state, 'cancelled');
  await incoming(env, message('START', { OptOutType: 'START' }));
  await incoming(env, message('YES')); assert.equal(row(env).status, 'stopped');
});

test('forged webhooks are rejected; signed requests work and repeated SID is ignored', async () => {
  const env = setup();
  const forged = signedRequest(env, message('TRIPLES')); forged.headers.set('X-Twilio-Signature', 'fake');
  assert.equal((await handleRequest(forged, env)).status, 403); assert.equal(row(env), undefined);
  const response = await handleRequest(signedRequest(env, message('TRIPLES')), env);
  assert.equal(response.status, 200); assert.match(await response.text(), /Reply YES/);
  assert.doesNotMatch(await (await handleRequest(signedRequest(env, message('TRIPLES')), env)).text(), /<Message>/);
});

test('repeated polling creates one delivery per subscriber; late joiners get no historical alert', async () => {
  const env = setup(); await join(env, event.occurredAt - 1000);
  await recordEvents(env, [event]); await recordEvents(env, [event]);
  await join(env, event.occurredAt + 1000, '+12025550124');
  await recordEvents(env, [event]);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM deliveries').get().n, 1);
});

test('dispatch sends once; subsequent polls cannot repeat it', async t => {
  const env = setup(); await join(env, event.occurredAt - 1000); await recordEvents(env, [event]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; assert.equal(options.body.get('To'), phone);
    return Response.json({ sid: 'SM' + 'd'.repeat(32) });
  });
  await dispatch(env); await dispatch(env);
  assert.equal(calls, 1); assert.equal(env.sqlite.prepare('SELECT state FROM deliveries').get().state, 'accepted');
});

test('unknown submission is not retried; a signed delivery callback resolves it', async t => {
  const env = setup(); await join(env, event.occurredAt - 1000); await recordEvents(env, [event]);
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Timeout'); });
  t.mock.method(console, 'error', () => {});
  await dispatch(env); await dispatch(env); assert.equal(calls, 1);
  const delivery = env.sqlite.prepare('SELECT * FROM deliveries').get(); assert.equal(delivery.state, 'unknown');
  await handleRequest(signedRequest(env, { MessageStatus: 'delivered' }, `/status?id=${delivery.id}`), env);
  assert.equal(env.sqlite.prepare('SELECT state FROM deliveries').get().state, 'delivered');
});

test('monthly cap limits sends, including across repeated dispatches', async t => {
  const env = setup(); env.MAX_ALERTS_PER_MONTH = '1';
  await join(env, event.occurredAt - 1000); await join(env, event.occurredAt - 1000, '+12025550124');
  await recordEvents(env, [event]); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ sid: 'SM' + 'd'.repeat(32) }); });
  await dispatch(env); await dispatch(env); assert.equal(calls, 1);
});

test('disabled polling makes no network calls', async t => {
  const env = setup(); t.mock.method(globalThis, 'fetch', () => assert.fail('must not contact providers'));
  await poll(env);
});

test('full scheduled poll checks MLB, records a real play, sends once, and tolerates a later feed outage', async t => {
  const env = setup(); env.ALERTS_ENABLED = 'true'; env.ALERTS_START_AT = new Date(occurred - 5000).toISOString();
  await join(env, occurred - 1000);
  let sent = 0; let outage = false;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('twilio.com')) { sent++; return Response.json({ sid: 'SM' + 'd'.repeat(32) }); }
    if (outage) throw new Error('MLB unavailable');
    if (url.includes('/schedule?')) return Response.json({ dates: [{ games: [{ gamePk: fixture.gamePk, gameType: 'R', status: { abstractGameState: 'Live' } }] }] });
    return Response.json(fixture);
  });
  await poll(env, occurred + 1000); await poll(env, occurred + 2000);
  assert.equal(sent, 1);
  await recordEvents(env, [{ ...event, id: 'next:1', occurredAt: occurred + 2000 }]);
  outage = true; await poll(env, occurred + 3000); assert.equal(sent, 2);
});

test('cleanup still removes expired signup records when alert delivery is paused', async () => {
  const env = setup();
  await incoming(env, message('TRIPLES'), 1000);
  await poll(env, 1000 + 8 * 86400000);
  assert.equal(row(env), undefined);
});

test('out-of-order callbacks do not regress delivered or sent messages', async t => {
  const env = setup(); await join(env, event.occurredAt - 1000); await recordEvents(env, [event]);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sid: 'SM' + 'c'.repeat(32) }));
  await dispatch(env);
  const delivery = env.sqlite.prepare('SELECT * FROM deliveries').get();
  for (const MessageStatus of ['sent', 'queued']) await handleRequest(signedRequest(env, { MessageStatus }, `/status?id=${delivery.id}`), env);
  assert.equal(env.sqlite.prepare('SELECT state FROM deliveries').get().state, 'sent');
  for (const MessageStatus of ['delivered', 'sent']) await handleRequest(signedRequest(env, { MessageStatus }, `/status?id=${delivery.id}`), env);
  assert.equal(env.sqlite.prepare('SELECT state FROM deliveries').get().state, 'delivered');
});
