(() => {
  const config = window.CORBIN_ALERTS || {};
  const phone = config.phoneNumber;
  const ready = /^\+1\d{10}$/.test(phone || '');
  const hasSupportEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail || '');
  const link = document.getElementById('sms-subscribe');
  const pending = document.getElementById('sms-coming-soon');
  const instructions = document.getElementById('sms-instructions');
  if (link && ready) {
    // iOS uses &body while Android uses ?body for a composed SMS.
    const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    link.href = `sms:${phone}${isApple ? '&' : '?'}body=TRIPLES`;
    link.hidden = false;
    pending.hidden = true;
    instructions.textContent = `Or text TRIPLES to ${phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')} for Corbin Triples alerts from Sasha Bates. Reply YES to confirm.`;
  }
  const form = document.getElementById('sms-form');
  if (form) {
    const submit = document.getElementById('sms-form-submit');
    const consent = document.getElementById('sms-consent');
    const status = document.getElementById('sms-form-status');
    const input = document.getElementById('sms-phone');
    let token = '';
    let widget;
    let busy = false;
    let endpoint;
    try {
      const base = new URL(config.apiBaseUrl);
      if (base.protocol === 'https:') endpoint = new URL('/subscribe', base).href;
    } catch { /* Keep the form closed until the backend is connected. */ }
    const updateButton = () => { submit.disabled = busy || !token || !consent.checked; };
    consent.addEventListener('change', updateButton);
    if (endpoint && config.turnstileSiteKey) {
      status.textContent = 'Complete the security check, then request your confirmation text.';
      window.onCorbinTurnstileReady = () => {
        widget = window.turnstile.render('#sms-turnstile', {
          sitekey: config.turnstileSiteKey,
          action: 'sms-signup',
          size: 'flexible',
          callback: value => { token = value; updateButton(); },
          'expired-callback': () => { token = ''; updateButton(); },
          'error-callback': () => {
            token = ''; updateButton();
            status.textContent = 'The security check could not load. Refresh to try again.';
          }
        });
      };
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onCorbinTurnstileReady&render=explicit';
      script.async = true;
      script.onerror = () => { status.textContent = 'The security check could not load. Refresh to try again.'; };
      document.head.append(script);
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!endpoint || !token || !consent.checked || busy || !form.reportValidity()) return;
      busy = true; updateButton();
      status.textContent = 'Requesting your confirmation text…';
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: input.value, consent: consent.checked, token }),
          signal: AbortSignal.timeout(30_000)
        });
        const result = await response.json();
        status.textContent = result.message || 'Something went wrong. Please try again later.';
        if (response.ok) form.reset();
      } catch {
        status.textContent = 'We could not confirm your request. If a text arrives, reply YES; otherwise, try again later.';
      } finally {
        busy = false; token = ''; updateButton();
        if (widget !== undefined) window.turnstile.reset(widget);
      }
    });
  }
  for (const contact of document.querySelectorAll('[data-sms-contact]')) {
    if (hasSupportEmail) {
      const anchor = document.createElement('a');
      anchor.href = `mailto:${config.supportEmail}`;
      anchor.textContent = config.supportEmail;
      contact.replaceChildren(anchor);
    }
  }
})();
