import { validateRequest } from 'twilio/lib/webhooks/webhooks.js';
import { tripleEvents, TEAM_ID } from './triples.js';

export const TERMS_VERSION = '2026-09-14';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const db = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const xml = text => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])}</Message>` : ''}</Response>`, {
  headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' }
});
const bounded = (value, fallback, max) => Math.max(1, Math.min(Number.parseInt(value, 10) || fallback, max));

export async function incoming(env, params, now = Date.now()) {
  const phone = params.From;
  const keyword = String(params.Body || '').trim().toUpperCase();
  const advanced = params.OptOutType;
  if (!/^\+1\d{10}$/.test(phone || '')) return '';

  // Honor opt-outs regardless of signup eligibility or capacity.
  if (advanced === 'STOP' || STOP.has(keyword)) {
    await env.DB.batch([
      db(env, "UPDATE subscribers SET status='stopped', updated_at=? WHERE phone=?", now, phone),
      db(env, "UPDATE deliveries SET state='cancelled' WHERE phone=? AND state='pending'", phone)
    ]);
    // Twilio/carriers acknowledge standard STOP commands themselves.
    return '';
  }
  // Configure Advanced Opt-Out's START reply to direct people to text TRIPLES.
  // START unblocks the sender; it never silently enrolls somebody.
  if (advanced === 'START' || advanced === 'HELP') return '';
  if (keyword === 'HELP' || keyword === 'INFO') {
    return `Corbin Triples alerts. Text TRIPLES to join, STOP to quit. Help: ${env.SUPPORT_EMAIL}`;
  }
  if (keyword === 'START' || keyword === 'UNSTOP') return '';
  if (params.FromCountry !== 'US') return 'Corbin Triples alerts currently support US numbers only.';

  const subscriber = await db(env, 'SELECT * FROM subscribers WHERE phone=?', phone).first();
  if (keyword === 'YES') {
    if (subscriber?.status === 'active') return '';
    if (subscriber?.status !== 'pending' || now - subscriber.requested_at > 15 * MINUTE) {
      return 'Text TRIPLES to start a new signup. Then reply YES within 15 minutes.';
    }
    const result = await db(env, `UPDATE subscribers SET status='active', confirmed_at=?, updated_at=?
      WHERE phone=? AND status='pending' AND requested_at>=?
      AND (SELECT COUNT(*) FROM subscribers WHERE status='active') < ?`,
    now, now, phone, now - 15 * MINUTE, bounded(env.MAX_SUBSCRIBERS, 100, 1000)).run();
    return result.meta.changes
      ? 'Corbin Triples: You are in! One text per regular-season triple. Frequency varies. Msg & data rates may apply. Reply STOP to quit, HELP for help.'
      : 'Corbin Triples: The list is full right now. Please try again later.';
  }
  if (keyword !== 'TRIPLES') return '';
  if (subscriber?.status === 'active') return 'Corbin Triples: You are already subscribed. Reply STOP to quit, HELP for help.';
  if (subscriber?.status === 'pending' && now - subscriber.requested_at < 10 * MINUTE) return '';
  await db(env, `INSERT INTO subscribers(phone,status,requested_at,updated_at,terms_version)
    VALUES(?,'pending',?,?,?) ON CONFLICT(phone) DO UPDATE SET status='pending',
    requested_at=excluded.requested_at, updated_at=excluded.updated_at,
    confirmed_at=NULL, terms_version=excluded.terms_version`, phone, now, now, TERMS_VERSION).run();
  return 'Corbin Triples: Reply YES to get automated triple alerts. Frequency varies. Msg & data rates may apply. STOP to quit. Terms: corbinstriples.com/sms-terms/';
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json({ ok: true, alertsEnabled: env.ALERTS_ENABLED === 'true' });
  }
  if (!['/sms', '/status'].includes(url.pathname) || request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!env.PUBLIC_URL || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_ACCOUNT_SID || !env.SUPPORT_EMAIL || !env.TWILIO_PHONE_NUMBER) {
    return new Response('Setup incomplete', { status: 503 });
  }
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Unsupported content type', { status: 415 });
  const raw = await request.text();
  if (raw.length > 20_000) return new Response('Too large', { status: 413 });
  const params = Object.fromEntries(new URLSearchParams(raw));
  const signedUrl = `${env.PUBLIC_URL.replace(/\/$/, '')}${url.pathname}${url.search}`;
  if (!validateRequest(env.TWILIO_AUTH_TOKEN, request.headers.get('X-Twilio-Signature') || '', signedUrl, params) || params.AccountSid !== env.TWILIO_ACCOUNT_SID) {
    return new Response('Forbidden', { status: 403 });
  }
  if (url.pathname === '/status') {
    const states = { queued: 'accepted', sending: 'accepted', sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed' };
    const state = states[params.MessageStatus];
    if (state && params.MessageSid) {
      await db(env, `UPDATE deliveries SET state=?, message_sid=?, error_code=?
        WHERE id=? AND (message_sid IS NULL OR message_sid=?)
        AND state NOT IN ('delivered','failed','cancelled') AND NOT (state='sent' AND ?='accepted')`,
      state, params.MessageSid, params.ErrorCode || null, url.searchParams.get('id'), params.MessageSid, state).run();
      if (params.ErrorCode === '21610' && params.To) {
        await incoming(env, { From: params.To, Body: 'STOP' });
      }
    }
    return xml('');
  }
  if (params.To !== env.TWILIO_PHONE_NUMBER || !/^SM[a-fA-F0-9]{32}$/.test(params.MessageSid || '')) return new Response('Forbidden', { status: 403 });
  const now = Date.now();
  const inserted = await db(env, 'INSERT OR IGNORE INTO incoming(sid,received_at) VALUES(?,?)', params.MessageSid, now).run();
  if (!inserted.meta.changes) return xml('');
  try {
    return xml(await incoming(env, params, now));
  } catch (error) {
    await db(env, 'DELETE FROM incoming WHERE sid=?', params.MessageSid).run();
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.json();
}

export async function recordEvents(env, events) {
  for (const event of events) {
    if (await db(env, 'SELECT id FROM events WHERE id=?', event.id).first()) continue;
    // Both statements commit together. A subscriber joining after the play never
    // receives that old play; the delivery primary key also covers concurrent polls.
    await env.DB.batch([
      db(env, 'INSERT OR IGNORE INTO events(id,occurred_at,body) VALUES(?,?,?)', event.id, event.occurredAt, event.body),
      db(env, `INSERT OR IGNORE INTO deliveries(id,event_id,phone)
        SELECT lower(hex(randomblob(16))), ?, phone FROM subscribers
        WHERE status='active' AND confirmed_at<=?`, event.id, event.occurredAt)
    ]);
  }
}

export async function dispatch(env, now = Date.now()) {
  const month = new Date(now).toISOString().slice(0, 7);
  await db(env, 'INSERT OR IGNORE INTO monthly_usage(month) VALUES(?)', month).run();
  await db(env, `UPDATE deliveries SET state='expired' WHERE state='pending'
    AND event_id IN (SELECT id FROM events WHERE occurred_at<?)`, now - 6 * 60 * MINUTE).run();
  const { results } = await db(env, `SELECT d.id,d.event_id,d.phone,e.body FROM deliveries d
    JOIN events e ON e.id=d.event_id WHERE d.state='pending' ORDER BY e.occurred_at LIMIT 10`).all();
  for (const item of results) {
    const claim = await db(env, `UPDATE deliveries SET state='submitting',claimed_at=? WHERE id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM subscribers WHERE phone=? AND status='active')`, now, item.id, item.phone).run();
    if (!claim.meta.changes) continue;
    const budget = await db(env, 'UPDATE monthly_usage SET attempts=attempts+1 WHERE month=? AND attempts<?',
      month, bounded(env.MAX_ALERTS_PER_MONTH, 1000, 100_000)).run();
    if (!budget.meta.changes) {
      await db(env, "UPDATE deliveries SET state='pending',claimed_at=NULL WHERE id=? AND state='submitting'", item.id).run();
      break;
    }
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: item.phone, MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
          Body: item.body, StatusCallback: `${env.PUBLIC_URL.replace(/\/$/, '')}/status?id=${item.id}` })
      });
      const result = await response.json();
      if (!response.ok) {
        // Never retry an uncertain submission automatically: the provider may
        // have accepted it even when our connection fails.
        await db(env, "UPDATE deliveries SET state=?,error_code=? WHERE id=? AND state='submitting'",
          response.status >= 500 ? 'unknown' : 'failed', String(result.code || response.status), item.id).run();
        if (result.code === 21610) {
          await incoming(env, { From: item.phone, Body: 'STOP' }, now);
          break;
        }
        if (response.status === 401 || response.status === 403 || response.status === 429) break;
        continue;
      }
      if (!result.sid) throw new Error('Missing message SID');
      await db(env, `UPDATE deliveries SET message_sid=?,state=CASE WHEN state IN ('submitting','unknown') THEN 'accepted' ELSE state END WHERE id=?`, result.sid, item.id).run();
    } catch {
      await db(env, "UPDATE deliveries SET state='unknown' WHERE id=? AND state='submitting'", item.id).run();
      console.error('SMS submission uncertain; inspect delivery', item.id);
    }
  }
}

export async function poll(env, now = Date.now()) {
  await cleanup(env, now);
  const startAt = Date.parse(env.ALERTS_START_AT);
  if (env.ALERTS_ENABLED !== 'true') return;
  if (!Number.isFinite(startAt) || !env.PUBLIC_URL || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) throw new Error('Alert setup incomplete');
  const date = time => new Date(time).toISOString().slice(0, 10);
  try {
    const schedule = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${TEAM_ID}&startDate=${date(now - DAY)}&endDate=${date(now)}`);
    for (const day of schedule.dates || []) {
      for (const game of day.games || []) {
        if (game.gameType !== 'R' || !['Live', 'Final'].includes(game.status?.abstractGameState)) continue;
        try {
          const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${game.gamePk}/feed/live`);
          await recordEvents(env, tripleEvents(feed, startAt, now));
        } catch { console.error('MLB game check failed', game.gamePk); }
      }
    }
  } catch { console.error('MLB schedule check failed'); }
  await dispatch(env, now);
}

export async function cleanup(env, now = Date.now()) {
  await env.DB.batch([
    db(env, 'DELETE FROM incoming WHERE received_at<?', now - 7 * DAY),
    db(env, "DELETE FROM subscribers WHERE status='pending' AND updated_at<?", now - 7 * DAY),
    db(env, "DELETE FROM subscribers WHERE status='stopped' AND updated_at<?", now - 90 * DAY),
    db(env, 'DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE occurred_at<?)', now - 90 * DAY)
  ]);
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch { console.error('Notification webhook failed'); return new Response('Try again', { status: 500 }); }
  },
  async scheduled(_controller, env) { await poll(env); }
};
