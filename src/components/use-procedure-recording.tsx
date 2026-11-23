import { Fragment, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';

export type ProcedureRecordingModalProps = {
  patientId: string;
  patientName: string;
  procedureId: string;
  onClose: (refresh: boolean) => void;
};

export function useProcedureRecording(
  kind: 'decision' | 'completion',
  RecordingModal: ComponentType<ProcedureRecordingModalProps>,
  patientId: string,
  patientName: string,
  onChange: () => void,
) {
  const { session } = useSession(),
    location = useLocation(),
    capture = useAppointmentBookingGuard();
  const submissions = usePendingCareSubmissions();
  const pending =
    kind === 'decision' ? submissions.procedureDecisions : submissions.procedureCompletions;
  const [selected, setSelected] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const user = session.user;
  const canRecord =
    user?.role === 'patient'
      ? kind === 'decision' && user.patientId === patientId
      : !!user?.doctorId && (user.role === 'doctor' || user.role === 'admin');
  useLayoutEffect(
    () => setSelected(null),
    [
      patientId,
      user?.id,
      user?.role,
      user?.patientId,
      user?.doctorId,
      session.csrfToken,
      location.key,
    ],
  );
  const attempts = [...pending.values()].filter(
    (a) =>
      canRecord && a.command.patientId === patientId && a.command.recordedByRole === user?.role,
  );
  function open(id: string) {
    if (!canRecord) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(id);
  }
  function close(refresh: boolean) {
    const current = capture(),
      previous = opener.current;
    setSelected(null);
    if (refresh) onChange();
    requestAnimationFrame(() => {
      if (!current()) return;
      if (previous?.isConnected) previous.focus();
      else {
        const trigger =
          selected &&
          document.querySelector<HTMLElement>(
            '[' + triggerAttribute + '="' + CSS.escape(selected) + '"]',
          );
        (
          trigger || document.querySelector<HTMLElement>('[data-procedure-decisions-heading]')
        )?.focus();
      }
    });
  }
  const actionName = kind === 'decision' ? 'Decision' : 'Completion';
  const triggerAttribute = 'data-procedure-' + kind;
  const controls = (
    <Fragment key={kind}>
      {!selected &&
        attempts.map((a) => (
          <div className="notice decision-resume" key={a.command.procedureId}>
            <p>
              {a.procedureTitle} · {actionName} awaiting confirmation
            </p>
            <button
              className="button button-secondary"
              {...{ [triggerAttribute]: a.command.procedureId }}
              onClick={() => open(a.command.procedureId)}
            >
              Resume procedure {kind}
            </button>
          </div>
        ))}
      {selected && canRecord && (
        <RecordingModal
          key={JSON.stringify([
            patientId,
            selected,
            user?.id,
            user?.role,
            user?.doctorId,
            user?.patientId,
            session.csrfToken,
            location.key,
          ])}
          patientId={patientId}
          patientName={patientName}
          procedureId={selected}
          onClose={close}
        />
      )}
    </Fragment>
  );
  return {
    controls,
    open,
    hasPending: (id: string) => attempts.some((a) => a.command.procedureId === id),
  };
}
