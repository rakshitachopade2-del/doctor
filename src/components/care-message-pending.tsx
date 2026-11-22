import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { CareMessageCommand } from '../../shared/care-message';
import { useSession } from '../lib';

const PendingMessages = createContext<Map<string, CareMessageCommand> | null>(null);

// Only unresolved sends survive client-side navigation. Sign-out and a new session discard them.
export function PendingMessagesProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const pending = useMemo(
    () => new Map<string, CareMessageCommand>(),
    [session.user?.id, session.csrfToken],
  );
  useLayoutEffect(() => {
    const clear = () => pending.clear();
    window.addEventListener('derma:session-invalidated', clear);
    window.addEventListener('derma:session-expired', clear);
    return () => {
      clear();
      window.removeEventListener('derma:session-invalidated', clear);
      window.removeEventListener('derma:session-expired', clear);
    };
  }, [pending]);
  return <PendingMessages.Provider value={pending}>{children}</PendingMessages.Provider>;
}

export function usePendingMessages() {
  const pending = useContext(PendingMessages);
  if (!pending) throw new Error('Care messages require an active workspace.');
  return pending;
}
