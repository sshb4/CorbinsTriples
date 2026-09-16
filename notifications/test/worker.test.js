import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { webSignup, normalizeUSPhone } from '../src/signup.js';
import twilio from 'twilio';
import { incoming, handleRequest, recordEvents, dispatch, poll } from '../src/worker.js';
import { tripleEvents } from '../src/triples.js';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  }
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
function pending(env, now, number = phone) {
  env.sqlite.prepare("INSERT OR REPLACE INTO subscribers(phone,status,requested_at,updated_at,terms_version,consent_source) VALUES(?,'pending',?,?,?,'web')").run(number, now, now, 'test');
}
async function join(env, now = Date.now() - 1000, number = phone) {
  pending(env, now - 1000, number);
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
  pending(env, 10000); assert.equal(row(env).status, 'pending');
  await incoming(env, message('YES'), 10000 + 16 * 60000); assert.equal(row(env).status, 'pending');
  pending(env, 10000 + 17 * 60000);
  await incoming(env, message('YES'), 10000 + 18 * 60000); assert.equal(row(env).status, 'active');
  const other = setup(); pending(other, 10000); await incoming(other, message('YES', { FromCountry: 'CA' }), 11000);
  assert.equal(row(other).status, 'pending');
});

test('capacity applies at confirmation, and repeated requests do not spam replies', async () => {
  const env = setup(); env.MAX_SUBSCRIBERS = '1';
  await join(env);
  const second = message('TRIPLES', { From: '+12025550124' });
  pending(env, Date.now(), second.From);
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
  pending(env, Date.now());
  const forged = signedRequest(env, message('YES')); forged.headers.set('X-Twilio-Signature', 'fake');
  assert.equal((await handleRequest(forged, env)).status, 403); assert.equal(row(env).status, 'pending');
  const response = await handleRequest(signedRequest(env, message('YES')), env);
  assert.equal(response.status, 200); assert.match(await response.text(), /You are in/);
  assert.doesNotMatch(await (await handleRequest(signedRequest(env, message('YES')), env)).text(), /<Message>/);
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
  pending(env, 1000);
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

function webEnv() {
  return { ...setup(), SITE_ORIGIN: 'https://corbinstriples.com', SIGNUPS_ENABLED: 'true', TURNSTILE_SECRET_KEY: 'test-key', MAX_WEB_SIGNUPS_PER_DAY: '100' };
}
function signupRequest(env, data = {}, origin = env.SITE_ORIGIN) {
  return new Request(env.PUBLIC_URL + '/subscribe', { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'
  }, body: JSON.stringify({ phone, consent: true, token: 'test-token', ...data }) });
}
function mockSignup(t, challenge = {}) {
  const calls = { texts: 0, verifications: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('siteverify')) {
      calls.verifications++;
      return Response.json({ success: true, hostname: 'corbinstriples.com', action: 'sms-signup', ...challenge });
    }
    assert.ok(url.startsWith('https://api.twilio.com/'));
    calls.texts++;
    assert.match(options.body.get('Body'), /Reply YES/);
    return Response.json({ sid: 'SM' + 'e'.repeat(32) });
  });
  return calls;
}

test('web phone validation normalizes US numbers and rejects Canadian, overseas, and malformed numbers', () => {
  assert.equal(normalizeUSPhone('(202) 555-0123'), phone);
  assert.equal(normalizeUSPhone('+1 202-555-0123'), phone);
  for (const value of ['+14165550123', '+442079460000', 'abc2025550123', '2025550123 ext 2', '', null]) {
    assert.equal(normalizeUSPhone(value), null);
  }
});

test('form requires affirmative consent and an approved origin before contacting providers', async t => {
  const env = webEnv(); const calls = mockSignup(t);
  assert.equal((await webSignup(signupRequest(env, { consent: false }), env)).status, 400);
  assert.equal((await webSignup(signupRequest(env, { consent: 'true' }), env)).status, 400);
  const foreign = await webSignup(signupRequest(env, {}, 'https://unrelated.example'), env);
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await webSignup(signupRequest(env, { token: '' }), env)).status, 400);
  assert.equal(calls.texts, 0); assert.equal(calls.verifications, 0);
});

test('invalid, reused, wrong-host or wrong-action security tokens never send a text', async t => {
  for (const challenge of [{ success: false }, { hostname: 'other.example' }, { action: 'other-action' }]) {
    const env = webEnv(); const calls = mockSignup(t, challenge);
    assert.equal((await webSignup(signupRequest(env), env)).status, 400);
    assert.equal(calls.texts, 0); assert.equal(row(env), undefined);
    t.mock.restoreAll();
  }
});

test('form requests one confirmation and stores consent source; only YES activates it', async t => {
  const env = webEnv(); const calls = mockSignup(t); const now = Date.now();
  const response = await handleRequest(signupRequest(env), env);
  assert.equal(response.status, 202); assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  assert.equal(calls.texts, 1); assert.equal(row(env).status, 'pending'); assert.equal(row(env).consent_source, 'web');
  assert.equal(env.sqlite.prepare('SELECT state FROM signup_requests').get().state, 'accepted');
  await incoming(env, message('YES'), now + 1000); assert.equal(row(env).status, 'active');
});

test('repeated form submissions do not resend immediately or exceed the per-number daily cap', async t => {
  const env = webEnv(); const calls = mockSignup(t); const now = Date.now();
  assert.equal((await webSignup(signupRequest(env), env, now)).status, 202);
  assert.equal((await webSignup(signupRequest(env), env, now + 1000)).status, 429);
  assert.equal((await webSignup(signupRequest(env), env, now + 11 * 60000)).status, 429);
  assert.equal(calls.texts, 1);
});

test('global form daily limit blocks additional SMS, independently of triple-alert allowance', async t => {
  const env = webEnv(); env.MAX_WEB_SIGNUPS_PER_DAY = '1'; const calls = mockSignup(t);
  assert.equal((await webSignup(signupRequest(env), env)).status, 202);
  assert.equal((await webSignup(signupRequest(env, { phone: '+12025550124' }), env)).status, 503);
  assert.equal(calls.texts, 1);
});

test('web signup never reverses a STOP or resends to an active subscriber', async t => {
  const env = webEnv(); const calls = mockSignup(t); await join(env);
  assert.equal((await webSignup(signupRequest(env), env)).status, 200);
  await incoming(env, message('STOP'));
  assert.equal((await webSignup(signupRequest(env), env)).status, 409);
  assert.equal(row(env).status, 'stopped'); assert.equal(calls.texts, 0);
});

test('uncertain provider response is reported honestly and not immediately retried', async t => {
  const env = webEnv(); let sends = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('siteverify')) return Response.json({ success: true, hostname: 'corbinstriples.com', action: 'sms-signup' });
    sends++; throw new Error('timeout');
  });
  assert.equal((await webSignup(signupRequest(env), env)).status, 502);
  assert.equal((await webSignup(signupRequest(env), env)).status, 429);
  assert.equal(sends, 1); assert.equal(row(env).status, 'pending');
  assert.equal(env.sqlite.prepare('SELECT state FROM signup_requests').get().state, 'unknown');
});

test('disabled web signup cannot send; browser preflight is supported', async t => {
  const env = webEnv(); env.SIGNUPS_ENABLED = 'false'; const calls = mockSignup(t);
  assert.equal((await webSignup(signupRequest(env), env)).status, 503); assert.equal(calls.texts, 0);
  const request = new Request(env.PUBLIC_URL + '/subscribe', { method: 'OPTIONS', headers: { Origin: env.SITE_ORIGIN } });
  const response = await handleRequest(request, env);
  assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
});

test('prelaunch saves consent without Twilio credentials or active enrollment', async t => {
  const env = webEnv(); env.SIGNUP_MODE = 'waitlist';
  delete env.TWILIO_ACCOUNT_SID; delete env.TWILIO_AUTH_TOKEN; delete env.TWILIO_MESSAGING_SERVICE_SID;
  const calls = mockSignup(t);
  const now = Date.now();
  const response = await webSignup(signupRequest(env), env, now);
  assert.equal(response.status, 202);
  assert.match((await response.json()).message, /No text has been sent/);
  const saved = env.sqlite.prepare('SELECT * FROM signup_waitlist').get();
  assert.equal(saved.phone, phone); assert.equal(saved.created_at, now);
  assert.equal(saved.terms_version, '2026-09-15'); assert.equal(saved.consent_source, 'web');
  assert.equal(row(env), undefined);
  await incoming(env, message('YES'), now + 1000);
  assert.equal(row(env), undefined);
  assert.equal((await webSignup(signupRequest(env), env, now + 1000)).status, 200);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM signup_waitlist').get().n, 1);
  assert.equal(calls.texts, 0);
});

test('prelaunch enforces consent, verification, capacity and paused switch', async t => {
  const env = webEnv(); env.SIGNUP_MODE = 'waitlist'; env.MAX_SUBSCRIBERS = '1';
  const calls = mockSignup(t);
  assert.equal((await webSignup(signupRequest(env, {consent:false}), env)).status, 400);
  assert.equal((await webSignup(signupRequest(env, {token:''}), env)).status, 400);
  assert.equal((await webSignup(signupRequest(env, {}, 'https://other.example'), env)).status, 403);
  assert.equal((await webSignup(signupRequest(env), env)).status, 202);
  assert.equal((await webSignup(signupRequest(env, {phone:'+12025550124'}), env)).status, 503);
  env.SIGNUPS_ENABLED = 'false';
  assert.equal((await webSignup(signupRequest(env), env)).status, 503);
  assert.equal(calls.texts, 0);
});

test('prelaunch rejects failed verification and respects STOP and retention', async t => {
  const env = webEnv(); env.SIGNUP_MODE = 'waitlist';
  const calls = mockSignup(t, {success:false});
  assert.equal((await webSignup(signupRequest(env), env)).status, 400);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM signup_waitlist').get().n, 0);
  const now=Date.now();
  env.sqlite.prepare('INSERT INTO signup_waitlist(phone,created_at,terms_version) VALUES(?,?,?)').run(phone,now,'test');
  await incoming(env,message('STOP'),now);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM signup_waitlist').get().n, 0);
  env.sqlite.prepare('INSERT INTO signup_waitlist(phone,created_at,terms_version) VALUES(?,?,?)').run(phone,now-91*86400000,'test');
  await poll(env,now);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM signup_waitlist').get().n, 0);
  assert.equal(calls.texts,0);
});


test('keyword signup is disabled and replies do not advertise it', async () => {
  const env = setup();
  for (const keyword of ['TRIPLES', 'START', 'UNSTOP', 'YES']) {
    const reply = await incoming(env, message(keyword));
    assert.doesNotMatch(reply, /Text TRIPLES/i);
    assert.equal(row(env), undefined);
  }
  for (const keyword of ['HELP', 'INFO']) {
    const reply = await incoming(env, message(keyword));
    assert.match(reply, /test@example.com/);
    assert.doesNotMatch(reply, /Text TRIPLES/i);
  }
});
