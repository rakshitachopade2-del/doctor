import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { CareMessageCommand } from '../../shared/care-message';
import type { IntakeSubmissionCommand } from '../../shared/intake-submission';
import type { CarePlanAttempt } from './care-plan-creation-helpers';
import type { DecisionAttempt } from './procedure-decision-helpers';
import type { ResultAttempt } from './investigation-result-helpers';
import type { ReviewAttempt } from './follow-up-review-helpers';
import type { ReviewedCheckIn } from './check-in-submission-helpers';
import type { ReviewedPayment } from './PaymentRecordingModal';
import type { InvoiceIssuanceAttempt } from './invoice-issuance-helpers';
import type { UploadAttempt } from './private-upload-helpers';
import { useSession } from '../lib';

interface PendingCareSubmissions {
  procedureDecisions: Map<string, DecisionAttempt>;
  investigationResults: Map<string, ResultAttempt>;
  followUpReviews: Map<string, ReviewAttempt>;
  checkInSubmission: { current: ReviewedCheckIn | null };
  paymentRecording: { current: ReviewedPayment | null };
  issuance: { current: InvoiceIssuanceAttempt | null };
  uploads: Map<string, UploadAttempt>;
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
      procedureDecisions: new Map<string, DecisionAttempt>(),
      investigationResults: new Map<string, ResultAttempt>(),
      followUpReviews: new Map<string, ReviewAttempt>(),
      checkInSubmission: { current: null as ReviewedCheckIn | null },
      paymentRecording: { current: null as ReviewedPayment | null },
      issuance: { current: null as InvoiceIssuanceAttempt | null },
      uploads: new Map<string, UploadAttempt>(),
      plans: new Map<string, CarePlanAttempt>(),
      messages: new Map<string, CareMessageCommand>(),
      intakes: new Map<string, IntakeSubmissionCommand>(),
    }),
    [
      session.user?.id,
      session.user?.role,
      session.user?.patientId,
      session.user?.doctorId,
      session.csrfToken,
    ],
  );
  useLayoutEffect(() => {
    const clear = () => {
      pending.procedureDecisions.clear();
      pending.investigationResults.clear();
      pending.followUpReviews.clear();
      pending.checkInSubmission.current = null;
      pending.paymentRecording.current = null;
      pending.issuance.current = null;
      pending.uploads.clear();
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
