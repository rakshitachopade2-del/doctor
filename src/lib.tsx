import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '../shared/types';
let csrfToken = '';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const mutating = !['GET', 'HEAD'].includes(method);
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(mutating ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: mutating ? JSON.stringify(options.body ?? {}) : undefined,
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'The server returned an unexpected response. Please try again.' }));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      csrfToken = '';
      window.dispatchEvent(new Event('derma:session-expired'));
    }
    throw new ApiError(data.error || 'Something went wrong. Please try again.', response.status);
  }
  if (path === '/api/session' || path.startsWith('/api/auth/'))
    csrfToken = data.csrfToken || csrfToken;
  return data as T;
}
type SessionContextType = {
  session: Session;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string;
};
const SessionContext = createContext<SessionContextType>(null!);
const ToastContext = createContext<(message: string, type?: 'success' | 'error') => void>(() => {});
export function AppProviders({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ user: null, demoMode: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState<{ id: number; message: string; type: string }[]>([]);
  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>('/api/session'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const expire = () => setSession((value) => ({ ...value, user: null, csrfToken: undefined }));
    window.addEventListener('derma:session-expired', expire);
    return () => window.removeEventListener('derma:session-expired', expire);
  }, []);
  const toast = useCallback((message: string, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5500);
  }, []);
  return (
    <SessionContext.Provider value={{ session, refresh, loading, error }}>
      <ToastContext.Provider value={toast}>
        {children}
        <div className="toast-container" aria-live="polite">
          {toasts.map((t) => (
            <div
              role={t.type === 'error' ? 'alert' : 'status'}
              key={t.id}
              className={`toast toast-${t.type}`}
            >
              <span>{t.message}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    </SessionContext.Provider>
  );
}
export const useSession = () => useContext(SessionContext);
export const useToast = () => useContext(ToastContext);
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState('');
  const current = useRef(0);
  const reload = useCallback(async () => {
    const id = ++current.current;
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api<T>(path);
      if (id === current.current) setData(result);
    } catch (e) {
      if (id === current.current) setError((e as Error).message);
    } finally {
      if (id === current.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void reload();
    return () => {
      current.current++;
    };
  }, [reload]);
  return { data, loading, error, reload };
}
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value));
}
export function money(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}
