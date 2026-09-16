# Corbin triple texts

The website stays on GitHub Pages. This separate Cloudflare Worker receives Twilio webhooks, stores subscriptions in D1, checks MLB once a minute, and sends texts. GitHub Pages cannot run this background service or keep API credentials private.

## Current state

Implemented and tested locally; not deployed. The user purchased (520) 777-0150 and is completing Sole Proprietor A2P 10DLC registration. No application SMS has been sent and no credentials are in the repo. The homepage shows only the phone form with an unchecked consent box. Pre-launch collection saves requests without sending texts. A YES reply to a later confirmation text is required before enrollment. Keyword support is retained in the backend for after approval.

Regular-season games only, US subscribers only. Default capacity: 100 active subscribers. Default automated alert limit: 1,000 attempted recipient messages per UTC calendar month. Signup replies and Twilio/carrier automatic replies are additional billable messages; this limit is not an account-wide spending cap. Configure Twilio billing alerts as well.

## Accounts and configuration needed

- Cloudflare account with Workers and D1.
- Upgraded Twilio account and the SMS-enabled local US number, approved for a Sole Proprietor A2P 10DLC campaign.
- Twilio Messaging Service containing that number.
- A public support email for the page, HELP response, and registration.
- A Cloudflare Turnstile widget for `corbinstriples.com`: a public site key and a private secret key.

Keep the support email and phone number consistent in `../alerts-config.js`, Worker vars, Twilio registration, and Messaging Service responses. Review the SMS terms/privacy pages and replace the support placeholder before launch. These pages have separate public URLs for the registration submission:

- https://corbinstriples.com/sms-terms/
- https://corbinstriples.com/sms-privacy/

## Set up Cloudflare

Run in this directory:

```sh
npm ci
npx wrangler login
npx wrangler d1 create corbin-triple-alerts
```

Copy the returned database ID into `wrangler.jsonc`. Set `TWILIO_PHONE_NUMBER` to E.164 format (`+1...`), `SUPPORT_EMAIL`, and then:

```sh
npx wrangler d1 migrations apply corbin-triple-alerts --remote
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID
npx wrangler secret put TURNSTILE_SECRET_KEY
npm run deploy
```

Each `secret put` prompts privately; never put credentials in `alerts-config.js`, source files, screenshots, or GitHub. The Worker is initially disabled for alerts. Take the HTTPS URL returned by deployment, set `PUBLIC_URL` to that exact origin without a trailing slash, and deploy again. This must match the URLs Twilio calls, because webhook signatures include the URL.

## Set up Twilio

Use a Messaging Service linked to the approved Sole Proprietor campaign and local number. Set incoming messages to POST to `https://YOUR-WORKER/sms` (send to this webhook, rather than dropping incoming messages). The application supplies its own per-message status callback URL for outbound alerts; preserve its query string.

Enable Advanced Opt-Out. Set the opt-in keywords to **START and UNSTOP only; remove YES**. YES belongs to this application's confirmation flow. Do not add TRIPLES as a provider-handled keyword. Keep STOP and standard opt-out synonyms. Forward opted-in/out webhooks to the Worker so the subscriber database stays synchronized.

Suggested Advanced Opt-Out replies (replace the email):

- START/UNSTOP: `Corbin Triples: Messages unblocked. Text TRIPLES, then YES, to subscribe to triple alerts. STOP to quit.`
- HELP/INFO: `Corbin Triples: One alert per regular-season triple. Text TRIPLES to join, STOP to quit. Help: YOUR_SUPPORT_EMAIL`
- STOP: `Corbin Triples: You are unsubscribed. Text START to unblock messages, then TRIPLES to join again.`

Twilio handles blocking; the app also cancels pending deliveries when it receives an opt-out. Already-submitted messages may be in flight. START only unblocks delivery; it does not activate a subscription.

For the current pre-launch campaign submission, describe only the website form.
The keyword implementation is retained for a later launch; the public site does
not advertise it during review. Use the current campaign wording at the end of
this document rather than describing the future keyword flow.

## Web signup setup

Create a Turnstile widget restricted to `corbinstriples.com`. Set `TURNSTILE_SECRET_KEY` using `wrangler secret put` as above. The widget uses action `sms-signup`; the server verifies the token, action, and hostname with Cloudflare before requesting any SMS.

Apply **both migrations**, including `0002_web_signup.sql`, before deploying the updated Worker. Set `SITE_ORIGIN` to the exact website origin. Only that origin receives CORS permission on POST `/subscribe`. There is no public endpoint that accepts arbitrary SMS content or enrolls a number immediately.

Fill `apiBaseUrl` in `../alerts-config.js` with the deployed Worker origin and `turnstileSiteKey` with the widget's public key. The form appears before connection, but cannot submit until the API URL and security key are configured. No local fake-success mode is used. Once registration, credentials, support information, and webhook tests are ready, set `SIGNUPS_ENABLED=true` and deploy. This switch is separate from `ALERTS_ENABLED`, allowing consent-flow testing before game alerts start.

Web requests are limited to 5 per IP per hour, 2 per number per UTC day, and 100 confirmation attempts per UTC day by default (`MAX_WEB_SIGNUPS_PER_DAY`). Recent confirmation requests also have a 10-minute cooldown. Failed attempts count toward limits. IP/phone rate-limit keys are HMAC hashes; raw IP addresses are not stored. Actual signup records necessarily contain the subscriber phone number. Existing active subscribers are not sent another confirmation; stopped subscribers must rejoin by SMS. These limits cover the web form only, not inbound SMS or carrier-generated responses.

## Test before public launch

Keep `ALERTS_ENABLED=false` while checking the following with a consenting test phone (these are real, billable texts):

1. Text TRIPLES. Receive the opt-in prompt. The database should say `pending`.
2. Reply YES within 15 minutes. Receive confirmation. The database should say `active`.
3. Reply HELP and verify the public support contact.
4. Reply STOP; verify the database says `stopped` and pending alerts are cancelled.
5. Text START, then TRIPLES and YES; verify fresh confirmation is required.
6. With web signup enabled, enter a consenting test number, leave the checkbox unchecked and verify continuing saves no number and makes no signup request. Check it, complete Turnstile, submit, and verify the number is pending until YES. Test repeated requests and STOP.
7. Send an explicitly identified test alert from Twilio to that consenting phone; verify delivery and account configuration. Do not label synthetic tests as real triples. Our automated tests cover real MLB detection and the outbox with a mocked provider; they do not replace a real carrier delivery test.

When ready, set `ALERTS_START_AT` to the current UTC timestamp, e.g. the output of `node -p 'new Date().toISOString()'`, and `ALERTS_ENABLED=true`. Deploy the Worker. Confirm the public phone number, support email, API origin, and Turnstile site key in `../alerts-config.js`, then publish the website changes. The button opens a composed SMS; it never sends a text by itself.

## Operation and limits

- Polls today's and yesterday's Diamondbacks regular-season games to cover games crossing UTC midnight and doubleheaders.
- Requires a completed play, Corbin's batter ID, and `eventType=triple`. A real April 6, 2025 play is the test fixture.
- Uses game ID + at-bat index, so two triples in one game are distinct.
- Ignores plays before activation, older than six hours, and plays before a subscriber confirmed. It does not backfill historical alerts.
- A unique delivery row per play and subscriber prevents repeated polling from sending duplicates. Up to 10 recipients are processed per run, so 100 recipients take about ten runs; this is not guaranteed instant delivery.
- An atomic claim prevents concurrent dispatches from submitting the same row. Once a request is attempted, ambiguous network outcomes are not automatically retried: avoiding duplicate texts takes priority over guaranteed delivery. Inspect `unknown` or stale `submitting` rows against Twilio logs before deciding whether to resend manually.
- Twilio status callbacks record accepted/sent/delivered/failed. A scoring change after a message has already gone out cannot retract it.
- When the monthly alert limit is reached, sends pause. Pending alerts expire six hours after the play. Adjust limits deliberately in Worker vars.
- Never put the subscriber database, phone numbers, or provider credentials in the public GitHub repository.
- Privacy cleanup removes webhook IDs after seven days, pending signups after seven days, stopped signups and delivery records after 90 days. Web request records are removed after 90 days and rate-limit hashes after expiry (up to 48 hours plus the next cleanup cycle). Cleanup runs even when alerts are paused. Provider logs/backups have their own retention.

To pause alerts: set `ALERTS_ENABLED=false` and deploy. To pause the public form, also set `SIGNUPS_ENABLED=false`. Incoming STOP handling continues.

## Local checks

```sh
npm test
npm run check
```

Tests use Node's in-memory SQLite with the real schema, Twilio's signature validator, and mocked outbound requests. They do not send SMS or require account credentials. Node 22.13+ is needed for `node:sqlite`; development here used Node 24.

For local Worker testing, use `npx wrangler d1 migrations apply corbin-triple-alerts --local`, then `npm run dev`. Put local test values in `.dev.vars` (gitignored). Do not configure a live Twilio number to an untested local tunnel.

Reference documentation: [Twilio webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request), [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), [Sole Proprietor registration](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-sole-proprietor-registration-overview-new%20experience), [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Pre-launch signup collection (September 15)

Use `SIGNUP_MODE=waitlist`, `SIGNUPS_ENABLED=true`, and `ALERTS_ENABLED=false`
for real database-only collection before campaign approval. Turnstile validation,
US-number validation, affirmative consent, per-IP/per-number limits, daily limits,
and the list capacity still apply. No Twilio credentials are needed for this mode.
Requests go into `signup_waitlist` with their original consent timestamp/version;
they do not create active subscribers. Repeated requests do not extend retention.
STOP removes saved requests; cleanup deletes them after 90 days. Support can remove
requests by phone from this table when asked by the number owner.

For the existing manually initialized D1 database, run **only**
`migrations/0003_waitlist.sql` in its Console before deploying this Worker.
Do not rerun migrations 0001/0002 over the existing tables. Publish the homepage,
policy pages and `alerts.js` changes together with enabling collection.

After approval, saved requests still require a confirmation text and a YES reply.
There is deliberately no automatic waitlist sender in this release: enabling
alerts or changing signup mode does not send to or enroll saved requests. Prepare
and test that controlled launch step before promising that confirmations were sent.
The direct web-confirmation flow remains available with `SIGNUP_MODE=sms` after
approval; its existing Twilio credentials and settings are required.

Suggested campaign-flow explanation: Visitors to https://corbinstriples.com/#sms-alerts
enter a US phone number, check an unchecked recurring-SMS consent box, complete
Turnstile, and submit. Before launch, we store the number and consent request and
show that no text was sent. After approval and launch, we send a confirmation text;
users must reply YES before enrollment. The website form is the only advertised
signup method during review. Frequency varies; message and data rates may
apply; STOP cancels and HELP provides support. Terms:
https://corbinstriples.com/sms-terms/ . Privacy:
https://corbinstriples.com/sms-privacy/ .


## Optional SMS consent (September 16)

The stats are accessible without an account, phone number, or SMS consent.
The separate SMS checkbox is optional and unchecked. Continuing without checking
it sends no signup request and saves no phone number. The explicit skip link
returns to the stats without requiring the form or security check. Selecting SMS
makes the phone field required; server-side consent and Turnstile checks remain.

Campaign wording: Visitors can freely use https://corbinstriples.com/ without an
account, phone number, or texts. At https://corbinstriples.com/#sms-alerts, an
optional, unchecked checkbox specifically requests recurring Corbin Triples SMS.
Visitors can leave it unchecked and continue without texts, or use the explicit
skip link to view stats; neither path submits their phone number. Only visitors
who select SMS, provide a US phone number, complete the security check, and submit
have a consent request stored. Before launch no text is sent. After approval and
launch, they must reply YES to a confirmation text before receiving alerts.
Frequency varies; message and data rates may apply. STOP cancels; HELP provides
support. Terms: https://corbinstriples.com/sms-terms/ .
Privacy: https://corbinstriples.com/sms-privacy/ .
