(() => {
  const config = window.CORBIN_ALERTS || {};
  const hasSupportEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail || '');
  const form = document.getElementById('sms-form');
  if (form) {
    const submit = document.getElementById('sms-form-submit');
    const consent = document.getElementById('sms-consent');
    const status = document.getElementById('sms-form-status');
    const input = document.getElementById('sms-phone');
    let token = '';
    let widget;
    let busy = false;
    let resizeWidget = () => {};
    let endpoint;
    try {
      const base = new URL(config.apiBaseUrl);
      if (base.protocol === 'https:') endpoint = new URL('/subscribe', base).href;
    } catch { /* Keep the form closed until the backend is connected. */ }
    // Keep the action available so validation explains what is missing.
    // Consent and security verification are still required before any request.
    const updateButton = () => { submit.disabled = busy; };
    updateButton();
    if (endpoint && config.turnstileSiteKey) {
      status.textContent = 'Complete the security check, then submit your signup request.';
      window.onCorbinTurnstileReady = () => {
        const container = document.getElementById('sms-turnstile');
        let widgetSize;
        resizeWidget = () => {
          const size = container.getBoundingClientRect().width < 300 ? 'compact' : 'flexible';
          if (busy || size === widgetSize) return;
          if (widget !== undefined) window.turnstile.remove(widget);
          token = ''; updateButton();
          widgetSize = size;
          widget = window.turnstile.render('#sms-turnstile', {
            sitekey: config.turnstileSiteKey,
            action: 'sms-signup',
            size,
            callback: value => { token = value; updateButton(); },
            'expired-callback': () => { token = ''; updateButton(); },
            'error-callback': () => {
              token = ''; updateButton();
              status.textContent = 'The security check could not load. Refresh to try again.';
            }
          });
        };
        resizeWidget();
        if (window.ResizeObserver) {
          new ResizeObserver(resizeWidget).observe(container);
        } else {
          window.addEventListener('resize', resizeWidget);
        }
      };
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onCorbinTurnstileReady&render=explicit';
      script.async = true;
      script.onerror = () => { status.textContent = 'The security check could not load. Refresh to try again.'; };
      document.head.append(script);
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      if (!consent.checked) {
        status.textContent = 'Please check the consent box to request text alerts.';
        consent.focus();
        return;
      }
      if (!endpoint || !config.turnstileSiteKey) {
        status.textContent = 'Phone signup is not open yet. Please check back soon.';
        return;
      }
      if (!token) {
        status.textContent = 'Complete the security check below before requesting your text. If it has not loaded, refresh the page and try again.';
        document.getElementById('sms-turnstile').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      busy = true; updateButton();
      status.textContent = 'Submitting your signup request…';
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
        resizeWidget();
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
