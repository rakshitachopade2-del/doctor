import type { ProcedurePlanAttempt } from './procedure-plan-helpers';
import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { ProfileEditAttempt } from './doctor-profile-edit-helpers';
import type { DoctorProfileCreationCommand } from '../../shared/doctor-profile-creation';
import type { StaffAccountCreationReview } from '../../shared/staff-account-creation';
import type { PatientRegistrationCommand } from '../../shared/patient-registration';
import type { CareMessageCommand } from '../../shared/care-message';
import type { IntakeSubmissionCommand } from '../../shared/intake-submission';
import type { CarePlanAttempt } from './care-plan-creation-helpers';
import type { ProcedureLinkAttempt } from './procedure-scheduling-helpers';
import type { ProcedureCancellationAttempt } from './procedure-cancellation-helpers';
import type { CompletionAttempt } from './procedure-completion-helpers';
import type { DecisionAttempt } from './procedure-decision-helpers';
import type { CancellationAttempt } from './investigation-cancellation-helpers';
import type { InvestigationOrderAttempt } from './investigation-order-helpers';
import type { AssignmentDraft } from '../pages/InvestigationWorklistPage';
import type { InvestigationReviewAttempt } from './InvestigationReviewModal';
import type { ResultAttempt } from './investigation-result-helpers';
import type { ReviewAttempt } from './follow-up-review-helpers';
import type { ReviewedCheckIn } from './check-in-submission-helpers';
import type { ReviewedPayment } from './PaymentRecordingModal';
import type { InvoiceIssuanceAttempt } from './invoice-issuance-helpers';
import type { UploadAttempt } from './private-upload-helpers';
import { useSession } from '../lib';

interface PendingCareSubmissions {
  doctorProfileEdits: Map<string, ProfileEditAttempt>;
  doctorProfileCreation: { current: DoctorProfileCreationCommand | null };
  staffAccountCreation: { current: StaffAccountCreationReview | null };
  patientRegistration: { current: PatientRegistrationCommand | null };
  procedurePlans: Map<string, ProcedurePlanAttempt>;
  procedureDecisions: Map<string, DecisionAttempt>;
  procedureVisitChanges: Map<string, ProcedureLinkAttempt>;
  procedureCancellations: Map<string, ProcedureCancellationAttempt>;
  procedureCompletions: Map<string, CompletionAttempt>;
  investigationCancellations: Map<string, CancellationAttempt>;
  investigationOrders: Map<string, InvestigationOrderAttempt>;
  investigationResults: Map<string, ResultAttempt>;
  investigationHandover: { current: AssignmentDraft | null };
  investigationReviews: Map<string, InvestigationReviewAttempt>;
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
      doctorProfileEdits: new Map<string, ProfileEditAttempt>(),
      doctorProfileCreation: { current: null as DoctorProfileCreationCommand | null },
      staffAccountCreation: { current: null as StaffAccountCreationReview | null },
      patientRegistration: { current: null as PatientRegistrationCommand | null },
      procedurePlans: new Map<string, ProcedurePlanAttempt>(),
      procedureDecisions: new Map<string, DecisionAttempt>(),
      procedureVisitChanges: new Map<string, ProcedureLinkAttempt>(),
      procedureCancellations: new Map<string, ProcedureCancellationAttempt>(),
      procedureCompletions: new Map<string, CompletionAttempt>(),
      investigationCancellations: new Map<string, CancellationAttempt>(),
      investigationOrders: new Map<string, InvestigationOrderAttempt>(),
      investigationResults: new Map<string, ResultAttempt>(),
      investigationHandover: { current: null as AssignmentDraft | null },
      investigationReviews: new Map<string, InvestigationReviewAttempt>(),
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
      pending.doctorProfileEdits.clear();
      pending.doctorProfileCreation.current = null;
      pending.staffAccountCreation.current = null;
      pending.patientRegistration.current = null;
      pending.procedurePlans.clear();
      pending.procedureDecisions.clear();
      pending.procedureVisitChanges.clear();
      pending.procedureCancellations.clear();
      pending.procedureCompletions.clear();
      pending.investigationCancellations.clear();
      pending.investigationOrders.clear();
      pending.investigationResults.clear();
      pending.investigationHandover.current = null;
      pending.investigationReviews.clear();
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
