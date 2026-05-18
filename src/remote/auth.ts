const TOKEN_KEY = 'parallel-code-token';

interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
}

interface TelegramGlobal {
  WebApp?: TelegramWebApp;
}

function telegramWebApp(): TelegramWebApp | null {
  const w = window as Window & { Telegram?: TelegramGlobal };
  return w.Telegram?.WebApp ?? null;
}

/**
 * When the SPA is loaded inside Telegram's Mini App container, exchange the
 * injected `initData` payload for a regular server session token. Returns
 * the minted token on success, or `null` when the page is loaded outside
 * Telegram or the exchange fails (in which case the caller falls back to
 * the QR-path flow).
 */
async function tryTelegramAuth(): Promise<string | null> {
  const webApp = telegramWebApp();
  const initData = webApp?.initData;
  if (!initData) return null;
  try {
    const res = await fetch('/api/telegram-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: initData,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) return null;
    try {
      webApp.ready?.();
    } catch {
      /* ready() is best-effort; ignore failures */
    }
    return body.token;
  } catch {
    return null;
  }
}

/**
 * Resolve a server session token from any of the supported auth paths,
 * in priority order:
 *   1. Telegram Mini App `initData` (when the SPA is loaded inside Telegram)
 *   2. `?token=` URL parameter (QR-scan flow)
 *   3. Token previously stored in localStorage
 */
export async function initAuth(): Promise<string | null> {
  const tgToken = await tryTelegramAuth();
  if (tgToken) {
    localStorage.setItem(TOKEN_KEY, tgToken);
    return tgToken;
  }

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search);
    return urlToken;
  }

  return localStorage.getItem(TOKEN_KEY);
}

/** Get the stored token. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Build an authenticated URL for API requests. */
export function apiUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** Build headers with auth token. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
