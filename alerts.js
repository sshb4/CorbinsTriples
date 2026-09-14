(() => {
  const config = window.CORBIN_ALERTS || {};
  const phone = config.phoneNumber;
  const ready = /^\+1\d{10}$/.test(phone || '') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail || '');
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
    instructions.textContent = `Or text TRIPLES to ${phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')}. Reply YES to confirm.`;
  }
  for (const contact of document.querySelectorAll('[data-sms-contact]')) {
    if (ready) {
      const anchor = document.createElement('a');
      anchor.href = `mailto:${config.supportEmail}`;
      anchor.textContent = config.supportEmail;
      contact.replaceChildren(anchor);
    }
  }
})();
