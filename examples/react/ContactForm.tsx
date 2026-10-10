'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

interface Turnstile {
  render(container: HTMLElement, options: {
    sitekey: string; action: string; callback: (token: string) => void;
    'expired-callback': () => void; 'error-callback': () => void;
  }): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile; } }

// Browser code gets only a public endpoint and site key, never server secrets.
export function ContactForm({ endpoint, siteKey }: { endpoint: string; siteKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const lastAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let disposed = false;
    function render() {
      if (!disposed && container.current && window.turnstile && widgetId.current === null) {
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey, action: 'contact', callback: setToken,
          'expired-callback': () => setToken(''),
          'error-callback': () => { setToken(''); setMessage('Spam verification could not load. Please refresh and try again.'); },
        });
      }
    }
    let script = document.querySelector<HTMLScriptElement>('script[data-openforms-turnstile]');
    if (!script && !window.turnstile) {
      script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.dataset.openformsTurnstile = 'true';
      document.head.appendChild(script);
    }
    const onError = () => setMessage('Spam verification could not load. Please refresh and try again.');
    script?.addEventListener('load', render);
    script?.addEventListener('error', onError);
    render();
    return () => {
      disposed = true;
      script?.removeEventListener('load', render);
      script?.removeEventListener('error', onError);
      if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !token) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const fields = {
      name: String(data.get('name') ?? ''), email: String(data.get('email') ?? ''),
      message: String(data.get('message') ?? ''), _gotcha: String(data.get('_gotcha') ?? ''),
    };
    const payload = JSON.stringify(fields);
    if (lastAttempt.current?.payload !== payload) lastAttempt.current = { payload, key: crypto.randomUUID() };
    setBusy(true); setMessage('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': lastAttempt.current.key },
        body: JSON.stringify({ ...fields, 'cf-turnstile-response': token }),
      });
      const result = await response.json() as { ok: boolean; error?: { message: string; fields?: Record<string, string> } };
      if (!response.ok || !result.ok) {
        const fieldErrors = Object.entries(result.error?.fields ?? {}).map(([field, code]) => field + ': ' + code.replaceAll('_', ' ')).join('. ');
        setMessage(fieldErrors || result.error?.message || 'Your submission could not be received. Please try again.');
      } else {
        form.reset(); lastAttempt.current = null; setMessage('Thank you. Your message has been received.');
      }
    } catch {
      // Reuse this key if the first request may have succeeded.
      setMessage('Your submission could not be confirmed. Try again with the same details.');
    } finally {
      setBusy(false); setToken('');
      if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    }
  }
  return (
    <form onSubmit={submit}>
      <p><label>Name <input name="name" required maxLength={100} autoComplete="name" /></label></p>
      <p><label>Email <input name="email" type="email" required maxLength={254} autoComplete="email" /></label></p>
      <p><label>Message <textarea name="message" required minLength={5} maxLength={8000} /></label></p>
      <div hidden aria-hidden="true"><input name="_gotcha" tabIndex={-1} autoComplete="off" /></div>
      <div ref={container} />
      <button type="submit" disabled={busy || !token}>{busy ? 'Sending…' : 'Send message'}</button>
      <p role="status" aria-live="polite">{message}</p>
    </form>
  );
}
