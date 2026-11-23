import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { CareMessageCommand } from '../../shared/care-message';
import type { IntakeSubmissionCommand } from '../../shared/intake-submission';
import type { CarePlanAttempt } from './care-plan-creation-helpers';
import { useSession } from '../lib';

interface PendingCareSubmissions {
  plans: Map<string, CarePlanAttempt>;
  messages: Map<string, CareMessageCommand>;
  intakes: Map<string, IntakeSubmissionCommand>;
}
const PendingSubmissions = createContext<PendingCareSubmissions | null>(null);

// Only unresolved sends survive client-side navigation. Sign-out and a new session discard them.
export function PendingCareProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const pending = useMemo(
    () => ({
      plans: new Map<string, CarePlanAttempt>(),
      messages: new Map<string, CareMessageCommand>(),
      intakes: new Map<string, IntakeSubmissionCommand>(),
    }),
    [session.user?.id, session.csrfToken],
  );
  useLayoutEffect(() => {
    const clear = () => {
      pending.plans.clear();
      pending.messages.clear();
      pending.intakes.clear();
    };
    window.addEventListener('derma:session-invalidated', clear);
    window.addEventListener('derma:session-expired', clear);
    return () => {
      clear();
      window.removeEventListener('derma:session-invalidated', clear);
      window.removeEventListener('derma:session-expired', clear);
    };
  }, [pending]);
  return <PendingSubmissions.Provider value={pending}>{children}</PendingSubmissions.Provider>;
}

export function usePendingCareSubmissions() {
  const pending = useContext(PendingSubmissions);
  if (!pending) throw new Error('Care submissions require an active session.');
  return pending;
}
