import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

const AUTH_HEADER = 'Authorization';
const LOCALE_HEADER = 'Accept-Language';

let configured = false;
let originalFetch: typeof window.fetch | null = null;

export const httpClient = axios;
export const apiV1Client = axios.create({ baseURL: '/api/v1' });

// MohoBot: session token lives in sessionStorage under 'moho-admin-session',
// matching the previous React dashboard (see dashboard/src/lib/api.ts there).
// It is session-scoped on purpose: closing the tab logs the admin out.
export const MOHO_SESSION_KEY = 'moho-admin-session';
export const MOHO_SESSION_USER_KEY = 'moho-admin-user';

function getToken(): string | null {
  try {
    return sessionStorage.getItem(MOHO_SESSION_KEY);
  } catch {
    return null;
  }
}

function getLocale(): string | null {
  return localStorage.getItem('astrbot-locale');
}

function setAxiosHeader(
  headers: InternalAxiosRequestConfig['headers'],
  key: string,
  value: string,
) {
  if (typeof headers.set === 'function') {
    headers.set(key, value);
    return;
  }
  headers[key] = value;
}

function attachAxiosHeaders(config: InternalAxiosRequestConfig) {
  // Dashboard credentials must not be attached to third-party requests.
  try {
    const requestUrl = new URL(axios.getUri(config), window.location.href);
    if (requestUrl.origin !== window.location.origin) return config;
  } catch {
    return config;
  }

  const token = getToken();
  if (token) {
    setAxiosHeader(config.headers, AUTH_HEADER, `Bearer ${token}`);
  }

  const locale = getLocale();
  if (locale) {
    setAxiosHeader(config.headers, LOCALE_HEADER, locale);
  }

  return config;
}

function normalizeAxiosError(error: AxiosError) {
  if (error.response?.status === 401) {
    let requestPath = '';
    try {
      const url = error.config?.url || '';
      const baseURL = error.config?.baseURL;
      const resolvedUrl =
        url && baseURL && !/^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)
          ? `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
          : url;
      const requestUrl = new URL(resolvedUrl || '/', window.location.origin);
      if (requestUrl.origin === window.location.origin) {
        requestPath = requestUrl.pathname;
      }
    } catch {
      requestPath = '';
    }

    const isAuthChallenge =
      [
        // MohoBot pre-auth endpoints (see docs/openapi.yaml).
        '/api/auth/login',
        '/api/auth/session',
        '/api/auth/bootstrap/session',
        '/api/setup/status',
        '/api/setup/init',
      ].includes(requestPath);

    if (requestPath.startsWith('/api/') && !isAuthChallenge) {
      // Clear the MohoBot session; also drop any stale AstrBot-era keys.
      try {
        sessionStorage.removeItem(MOHO_SESSION_KEY);
        sessionStorage.removeItem(MOHO_SESSION_USER_KEY);
      } catch {
        // Storage availability must not prevent the login redirect.
      }
      ['user', 'token'].forEach((key) => localStorage.removeItem(key));

      if (!window.location.hash.startsWith('#/auth/login')) {
        window.location.hash = '/auth/login';
      }
    }
  }

  if (error.response?.status === 429) {
    const data = error.response.data as { message?: string } | undefined;
    if (data?.message) {
      return Promise.reject(data.message);
    }
  }
  return Promise.reject(error);
}

function installAxiosInterceptors(instance: AxiosInstance) {
  instance.interceptors.request.use(attachAxiosHeaders);
  instance.interceptors.response.use((response) => response, normalizeAxiosError);
}

export function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit) {
  const fetchImpl = originalFetch ?? window.fetch.bind(window);
  // The global fetch wrapper also handles public, cross-origin resources.
  try {
    const requestUrl = new URL(
      input instanceof Request ? input.url : input,
      window.location.href,
    );
    if (requestUrl.origin !== window.location.origin) {
      return fetchImpl(input, init);
    }
  } catch {
    return fetchImpl(input, init);
  }

  const token = getToken();
  const locale = getLocale();

  if (!token && !locale) {
    return fetchImpl(input, init);
  }

  const requestHeaders =
    typeof input !== 'string' && 'headers' in input
      ? (input as Request).headers
      : undefined;
  const headers = new Headers(init?.headers || requestHeaders);

  if (token && !headers.has(AUTH_HEADER)) {
    headers.set(AUTH_HEADER, `Bearer ${token}`);
  }
  if (locale && !headers.has(LOCALE_HEADER)) {
    headers.set(LOCALE_HEADER, locale);
  }

  return fetchImpl(input, { ...init, headers });
}

export function setupHttpClient() {
  if (configured) {
    return;
  }

  installAxiosInterceptors(axios);
  installAxiosInterceptors(apiV1Client);

  originalFetch = window.fetch.bind(window);
  window.fetch = fetchWithAuth;

  configured = true;
}
