import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { SIGNUP_PROMPT, TERMS_VERSION } from './messages.js';

const db = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const HOUR = 3_600_000;

export function normalizeUSPhone(value) {
  if (typeof value !== 'string' || value.length > 25 || !/^[+\d\s().-]+$/.test(value)) return null;
  const phone = parsePhoneNumberFromString(value, 'US');
  return phone?.country === 'US' && phone.isValid() && !phone.ext ? phone.number : null;
}

async function hashedKey(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

async function reserve(env, key, limit, expiresAt) {
  const result = await db(env, `INSERT INTO signup_limits(key,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`, key, expiresAt, limit).run();
  return result.meta.changes > 0;
}

export async function webSignup(request, env, now = Date.now()) {
  const origin = request.headers.get('Origin');
  const allowed = origin && origin === env.SITE_ORIGIN;
  const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  const reply = (status, message) => Response.json({ message }, { status, headers });
  if (!allowed) return reply(403, 'This signup must come from the Corbin Triples website.');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600'
  } });
  if (request.method !== 'POST') return reply(405, 'Use the signup form to subscribe.');
  const waitlist = env.SIGNUP_MODE === 'waitlist';
  if (env.SIGNUPS_ENABLED !== 'true' || !env.TURNSTILE_SECRET_KEY || !env.SUPPORT_EMAIL ||
      (!waitlist && (!env.TWILIO_AUTH_TOKEN || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_MESSAGING_SERVICE_SID))) {
    return reply(503, 'Phone signup is not open yet. Please check back soon.');
  }
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply(415, 'Invalid form submission.');
  if (Number(request.headers.get('Content-Length')) > 8192) return reply(413, 'Form submission is too large.');
  let data;
  try {
    const body = await request.text();
    if (body.length > 8192) return reply(413, 'Form submission is too large.');
    data = JSON.parse(body);
  } catch { return reply(400, 'Invalid form submission. Please try again.'); }
  const phone = normalizeUSPhone(data?.phone);
  if (!phone) return reply(400, 'Enter a valid US phone number.');
  if (data.consent !== true) return reply(400, 'Please check the consent box to request text alerts.');
  if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) return reply(400, 'Complete the security check and try again.');

  try {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return reply(503, 'Signup is temporarily unavailable. Please try again later.');
    const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: data.token, remoteip: ip })
    });
    if (!verification.ok) return reply(503, 'The security check is unavailable. Please try again later.');
    const challenge = await verification.json();
    if (!challenge.success || challenge.hostname !== new URL(env.SITE_ORIGIN).hostname || challenge.action !== 'sms-signup') {
      return reply(400, 'The security check expired or failed. Please try again.');
    }
    const day = Math.floor(now / (24 * HOUR));
    const hour = Math.floor(now / HOUR);
    // Store keyed hashes, not raw visitor IPs. Reserve atomically, including
    // failed provider attempts, to bound costs under concurrent submissions.
    const ipKey = await hashedKey(`ip:${ip}:${hour}`, env.TURNSTILE_SECRET_KEY);
    if (!await reserve(env, ipKey, 5, now + 24 * HOUR)) return reply(429, 'Too many requests. Please try again later.');
    const phoneKey = await hashedKey(`phone:${phone}:${day}`, env.TURNSTILE_SECRET_KEY);
    if (!await reserve(env, phoneKey, 2, now + 48 * HOUR)) return reply(429, 'A signup was already requested for this number. Please check your texts or try tomorrow.');
    const subscriber = await db(env, 'SELECT status,requested_at FROM subscribers WHERE phone=?', phone).first();
    if (subscriber?.status === 'active') return reply(200, 'If this number is already subscribed, you are all set. Otherwise, check your texts and reply YES to confirm.');
    if (subscriber?.status === 'stopped') return reply(409, 'To rejoin after stopping texts, text START to (520) 777-0150, then TRIPLES.');
    if (waitlist) {
      const savedMessage = 'Your request is saved. Text alerts have not launched yet. After launch, we will send a confirmation text; reply YES to activate your subscription. No text has been sent now.';
      const existing = await db(env, 'SELECT phone FROM signup_waitlist WHERE phone=?', phone).first();
      if (existing) return reply(200, savedMessage);
      const capacity = Math.max(1, Math.min(parseInt(env.MAX_SUBSCRIBERS, 10) || 100, 1000));
      const dailyLimit = Math.max(1, Math.min(parseInt(env.MAX_WEB_SIGNUPS_PER_DAY, 10) || 100, 1000));
      if (!await reserve(env, `global:${day}`, dailyLimit, now + 48 * HOUR)) return reply(503, 'Signups are paused for today. Please try tomorrow.');
      const saved = await db(env, `INSERT OR IGNORE INTO signup_waitlist(phone,created_at,terms_version)
        SELECT ?,?,? WHERE (SELECT COUNT(*) FROM signup_waitlist) < ?`, phone, now, TERMS_VERSION, capacity).run();
      if (!saved.meta.changes) {
        if (await db(env, 'SELECT phone FROM signup_waitlist WHERE phone=?', phone).first()) return reply(200, savedMessage);
        return reply(503, 'The list is full right now. Please try again later.');
      }
      return reply(202, savedMessage);
    }
    if (subscriber && now - subscriber.requested_at < 10 * 60_000) return reply(429, 'A confirmation was recently requested. Check your texts, or try again in 10 minutes.');
    const active = await db(env, "SELECT COUNT(*) AS count FROM subscribers WHERE status='active'").first();
    const capacity = Math.max(1, Math.min(parseInt(env.MAX_SUBSCRIBERS, 10) || 100, 1000));
    if (active.count >= capacity) return reply(503, 'The list is full right now. Please try again later.');
    const dailyLimit = Math.max(1, Math.min(parseInt(env.MAX_WEB_SIGNUPS_PER_DAY, 10) || 100, 1000));
    if (!await reserve(env, `global:${day}`, dailyLimit, now + 48 * HOUR)) return reply(503, 'Signups are paused for today. Please try tomorrow.');
    const claimed = await db(env, `INSERT INTO subscribers(phone,status,requested_at,updated_at,terms_version,consent_source)
      VALUES(?,'pending',?,?,?,'web') ON CONFLICT(phone) DO UPDATE SET requested_at=excluded.requested_at,
      updated_at=excluded.updated_at,confirmed_at=NULL,terms_version=excluded.terms_version,consent_source='web'
      WHERE subscribers.status='pending' AND subscribers.requested_at<=?`, phone, now, now, TERMS_VERSION, now - 10 * 60_000).run();
    if (!claimed.meta.changes) return reply(429, 'A signup is already being processed. Please check your texts.');
    const id = crypto.randomUUID();
    await db(env, "INSERT INTO signup_requests(id,phone,created_at,terms_version,state) VALUES(?,?,?,?,'submitting')", id, phone, now, TERMS_VERSION).run();
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: phone, MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, Body: SIGNUP_PROMPT })
      });
      const result = await response.json();
      if (!response.ok) {
        await db(env, 'UPDATE signup_requests SET state=? WHERE id=?', response.status >= 500 ? 'unknown' : 'failed', id).run();
        if (result.code === 21610) await db(env, "UPDATE subscribers SET status='stopped',updated_at=? WHERE phone=? AND status='pending'", now, phone).run();
        return reply(502, 'We could not confirm delivery of your signup text. If it arrives, reply YES. Otherwise, try again later.');
      }
      if (!result.sid) throw new Error('Missing message SID');
      await db(env, "UPDATE signup_requests SET state='accepted',message_sid=? WHERE id=?", result.sid, id).run();
      return reply(202, 'Check your texts and reply YES within 15 minutes to confirm. You are not subscribed until you reply.');
    } catch {
      await db(env, "UPDATE signup_requests SET state='unknown' WHERE id=? AND state='submitting'", id).run();
      return reply(502, 'We could not confirm delivery of your signup text. If it arrives, reply YES. Otherwise, try again later.');
    }
  } catch {
    console.error('Web signup failed');
    return reply(503, 'Signup is temporarily unavailable. Please try again later.');
  }
}
