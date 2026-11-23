import { Link } from 'react-router-dom';
import type { ProcedureRecord } from '../../shared/clinical';
import type { ProcedureAppointmentSnapshot } from '../../shared/procedure-scheduling';
import { formatDate } from '../lib';
import { ProcedureTemplateSource } from './ProcedureTemplateSource';

export function ProcedureDetails({ procedure }: { procedure: ProcedureRecord }) {
  return (
    <>
      <ProcedureTemplateSource source={procedure.templateSource} />
      <dl className="patient-workflow-details procedure-information">
        {[
          ['Reason for the procedure', procedure.indication],
          ['Expected benefits', procedure.benefits],
          ['Risks and precautions', procedure.risks],
          ['Alternatives', procedure.alternatives],
          ['Planned aftercare', procedure.aftercare],
          ['Estimated cost', procedure.estimatedCost],
        ].map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text || 'Not recorded. Ask your clinician for clarification.'}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function ProcedureVisit({
  appointment,
  linked,
  completed = false,
  planned = false,
}: {
  appointment: ProcedureAppointmentSnapshot | null | undefined;
  linked: boolean;
  completed?: boolean;
  planned?: boolean;
}) {
  const [hours, minutes] = (appointment?.time ?? '00:00').split(':').map(Number);
  const end = hours * 60 + minutes + (appointment?.durationMinutes ?? 0);
  const needsAttention =
    planned &&
    appointment &&
    (['cancelled', 'no-show', 'completed'].includes(appointment.status) ||
      (appointment.status === 'scheduled' &&
        Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) <= Date.now()));
  return (
    <div className="patient-procedure-visit">
      <h4>{completed ? 'Visit recorded at completion' : 'Linked visit'}</h4>
      {appointment ? (
        <>
          <p>
            {formatDate(appointment.date)} · {appointment.time}–
            {String(Math.floor(end / 60)).padStart(2, '0')}:{String(end % 60).padStart(2, '0')} IST
            · {appointment.durationMinutes} minutes
          </p>
          <p>
            {appointment.doctorName} ·{' '}
            {appointment.mode === 'online' ? 'Online visit' : 'In-person visit'}
            {appointment.durationPolicy === 'custom' && ' · Custom length'}
          </p>
          <p>Appointment status: {appointment.status.replaceAll('-', ' ')}</p>
          {needsAttention && (
            <p>Contact the clinic to confirm the visit for this planned procedure.</p>
          )}
        </>
      ) : (
        <p>
          {completed
            ? 'No appointment was linked when completion was recorded.'
            : linked
              ? 'The linked visit details are unavailable. Contact the clinic for confirmation.'
              : 'No appointment is currently linked to this procedure.'}
        </p>
      )}
      {!completed && (
        <p className="small muted">
          A visit link does not change your recorded procedure decision.
          {appointment && (
            <>
              {' '}
              <Link to="/my-care" className="text-link">
                View your appointments
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export function CurrentProcedureVisit({ procedure }: { procedure: ProcedureRecord }) {
  const effectiveId =
    procedure.effectiveAppointmentId === undefined
      ? procedure.appointmentId
      : procedure.effectiveAppointmentId;
  return (
    <ProcedureVisit
      appointment={procedure.scheduledAppointment}
      linked={effectiveId !== null}
      planned={procedure.status === 'planned'}
    />
  );
}
