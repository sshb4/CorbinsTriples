# Corbin triple texts

The website stays on GitHub Pages. This separate Cloudflare Worker receives Twilio webhooks, stores subscriptions in D1, checks MLB once a minute, and sends texts. GitHub Pages cannot run this background service or keep API credentials private.

## Current state

Implemented and tested locally; not deployed. No phone number has been purchased, no SMS has been sent, and no credentials are in the repo. The homepage says “Coming soon” until its public settings are filled in. Twilio must approve the sender before public enrollment opens.

Regular-season games only, US subscribers only. Default capacity: 100 active subscribers. Default automated alert limit: 1,000 attempted recipient messages per UTC calendar month. Signup replies and Twilio/carrier automatic replies are additional billable messages; this limit is not an account-wide spending cap. Configure Twilio billing alerts as well.

## Accounts and configuration needed

- Cloudflare account with Workers and D1.
- Upgraded Twilio account and verified US toll-free number.
- Twilio Messaging Service containing that number.
- A public support email for the page, HELP response, and registration.

Keep the support email and phone number consistent in `../alerts-config.js`, Worker vars, Twilio registration, and Messaging Service responses. Review the SMS terms/privacy pages and replace the support placeholder before launch. These pages have separate public URLs for the verification submission:

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
npm run deploy
```

Each `secret put` prompts privately; never put credentials in `alerts-config.js`, source files, screenshots, or GitHub. The Worker is initially disabled for alerts. Take the HTTPS URL returned by deployment, set `PUBLIC_URL` to that exact origin without a trailing slash, and deploy again. This must match the URLs Twilio calls, because webhook signatures include the URL.

## Set up Twilio

Create a Messaging Service using the verified toll-free number. Set incoming messages to POST to `https://YOUR-WORKER/sms` (send to this webhook, rather than dropping incoming messages). The application supplies its own per-message status callback URL for outbound alerts; preserve its query string.

Enable Advanced Opt-Out. Set the opt-in keywords to **START and UNSTOP only; remove YES**. YES belongs to this application's confirmation flow. Do not add TRIPLES as a provider-handled keyword. Keep STOP and standard opt-out synonyms. Forward opted-in/out webhooks to the Worker so the subscriber database stays synchronized.

Suggested Advanced Opt-Out replies (replace the email):

- START/UNSTOP: `Corbin Triples: Messages unblocked. Text TRIPLES, then YES, to subscribe to triple alerts. STOP to quit.`
- HELP/INFO: `Corbin Triples: One alert per regular-season triple. Text TRIPLES to join, STOP to quit. Help: YOUR_SUPPORT_EMAIL`
- STOP: `Corbin Triples: You are unsubscribed. Text START to unblock messages, then TRIPLES to join again.`

Toll-free carriers may replace the STOP response and send their own START response. Twilio handles blocking; the app also cancels pending deliveries when it receives an opt-out. Already-submitted messages may be in flight. START only unblocks delivery; it does not activate a subscription.

For toll-free verification, describe the actual independent fan alert program and this opt-in flow: visitor sees the disclosure, texts TRIPLES from their phone, receives the confirmation prompt, and replies YES. Use the real operator details and support email. Twilio approval is external and is not guaranteed by the code.

## Test before public launch

Keep `ALERTS_ENABLED=false` while checking the following with a consenting test phone (these are real, billable texts):

1. Text TRIPLES. Receive the opt-in prompt. The database should say `pending`.
2. Reply YES within 15 minutes. Receive confirmation. The database should say `active`.
3. Reply HELP and verify the public support contact.
4. Reply STOP; verify the database says `stopped` and pending alerts are cancelled.
5. Text START, then TRIPLES and YES; verify fresh confirmation is required.
6. Send an explicitly identified test alert from Twilio to that consenting phone; verify delivery and account configuration. Do not label synthetic tests as real triples. Our automated tests cover real MLB detection and the outbox with a mocked provider; they do not replace a real carrier delivery test.

When ready, set `ALERTS_START_AT` to the current UTC timestamp, e.g. the output of `node -p 'new Date().toISOString()'`, and `ALERTS_ENABLED=true`. Deploy the Worker. Then fill in `phoneNumber` and `supportEmail` in `../alerts-config.js` and publish the website changes. The button opens a composed SMS; it never sends a text by itself.

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
- Privacy cleanup removes webhook IDs after seven days, pending signups after seven days, stopped signups and delivery records after 90 days. Provider logs/backups have their own retention.

To pause alerts: set `ALERTS_ENABLED=false` and deploy. Incoming STOP handling continues.

## Local checks

```sh
npm test
npm run check
```

Tests use Node's in-memory SQLite with the real schema, Twilio's signature validator, and mocked outbound requests. They do not send SMS or require account credentials. Node 22.13+ is needed for `node:sqlite`; development here used Node 24.

For local Worker testing, use `npx wrangler d1 migrations apply corbin-triple-alerts --local`, then `npm run dev`. Put local test values in `.dev.vars` (gitignored). Do not configure a live Twilio number to an untested local tunnel.

Reference documentation: [Twilio webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request), [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), [toll-free verification](https://www.twilio.com/docs/messaging/compliance/toll-free/api-onboarding), [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
