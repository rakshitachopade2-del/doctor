import { useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowUpRight, Send } from 'lucide-react';
import type { CareMessageCommand } from '../../shared/care-message';
import type { Message, User } from '../../shared/types';
import { api, useSession } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { checkedMessageSettings, confirmedMessage, messageNotSent } from './care-message-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { Field } from './ui';

type Props = { patientId: string; canSend: boolean; onSaved: () => void };

export function CareMessageComposer(props: Props) {
  const { session } = useSession();
  const location = useLocation();
  if (!session.user) return null;
  return (
    <Composer
      key={JSON.stringify([session.user.id, session.csrfToken, location.key, props.patientId])}
      {...props}
      actor={session.user}
    />
  );
}

function Composer({ patientId, canSend, onSaved, actor }: Props & { actor: User }) {
  const { messages: pending } = usePendingCareSubmissions();
  const command = pending.get(patientId);
  const [draft, setDraft] = useState(command?.body ?? '');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [rejected, setRejected] = useState(false);
  const [saved, setSaved] = useState<Message | null>(null);
  const [checkedAvailability, setCheckedAvailability] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const capture = useAppointmentBookingGuard();
  const availabilityUnknown = checking || !!checkError;
  const enabled = !availabilityUnknown && (checkedAvailability ?? canSend);
  const patient = actor.role === 'patient';
  const value = command?.body ?? draft;
  const pausedCopy = patient
    ? 'Messaging is paused. Your existing conversation remains available. Contact the clinic directly for new questions.'
    : 'New messages are paused because the clinic has disabled the follow-up module. Previous messages remain available.';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || rejected || checking || (!command && (!enabled || !draft.trim())))
      return;
    const sent: CareMessageCommand = command ?? {
      patientId,
      requestId: crypto.randomUUID(),
      body: draft.trim(),
    };
    const origin = capture();
    const current = () => origin() && pending.get(patientId) === sent;
    submitting.current = true;
    pending.set(patientId, sent);
    setBusy(true);
    setSaved(null);
    try {
      const response = await api<unknown>('/api/messages/send', {
        method: 'POST',
        body: sent,
        isCurrent: current,
      });
      if (!current()) return;
      const message = confirmedMessage(response, sent, actor.id);
      if (!message) return;
      pending.delete(patientId);
      setSaved(message);
      setDraft('');
      // A recovered receipt describes the original send, even if messaging has since paused.
      if (command) void checkAvailability();
      onSaved();
    } catch (error) {
      if (current() && messageNotSent(error, sent, actor.id)) {
        pending.delete(patientId);
        setDraft(sent.body);
        setRejected(true);
        setCheckedAvailability(false);
      }
    } finally {
      if (origin()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  async function checkAvailability() {
    const current = capture();
    setChecking(true);
    setRejected(false);
    setCheckError('');
    try {
      const settings = checkedMessageSettings(
        await api<unknown>('/api/settings', { isCurrent: current }),
      );
      if (current()) setCheckedAvailability(settings.modules.followUp);
    } catch {
      if (current()) setCheckError('Could not check messaging availability. Please try again.');
    } finally {
      if (current()) setChecking(false);
    }
  }

  const confirmation = saved && (
    <p role="status" className="notice">
      Message saved by {saved.authorName} on{' '}
      {new Date(saved.createdAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      })}{' '}
      IST.
    </p>
  );

  const availabilityNotice = checking ? (
    <p role="status" className="notice">
      Checking messaging availability…
    </p>
  ) : checkError ? (
    <p role="alert" className="notice notice-error">
      {checkError}
    </p>
  ) : (
    <div className="notice">{pausedCopy}</div>
  );
  if (!enabled && !command && !draft && !rejected) {
    return (
      <>
        {confirmation}
        {availabilityNotice}
        {checkError && (
          <button type="button" className="button button-secondary" onClick={checkAvailability}>
            Check availability
          </button>
        )}
      </>
    );
  }
  return (
    <form
      onSubmit={submit}
      className={patient ? 'message-composer' : 'stack clinic-message-composer'}
    >
      {confirmation}
      <Field label={patient ? 'Your message' : 'Message to patient'}>
        <textarea
          className="textarea"
          rows={3}
          required
          maxLength={patient ? 2000 : 4000}
          value={value}
          readOnly={!!command || rejected}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(null);
          }}
          placeholder={
            patient
              ? 'Write a question or update for your clinic…'
              : 'Write a clear, patient-friendly message…'
          }
        />
      </Field>
      {command && (
        <div role="status" className="notice care-message-status">
          <strong>{busy ? 'Sending message' : 'Send unconfirmed'}</strong>
          <p>
            {busy
              ? 'Checking whether this message was saved.'
              : 'Retry the exact message to confirm whether it was saved. You can return to this conversation in this tab.'}{' '}
            Refreshing the page or signing out clears your retry details.
          </p>
        </div>
      )}
      {rejected && (
        <div role="alert" className="notice care-message-status">
          <strong>Message was not sent</strong>
          <p>
            The clinic paused new messages. You can edit this draft and send it when messaging
            resumes.
          </p>
        </div>
      )}
      {!enabled && !command && !rejected && availabilityNotice}
      <div className="row between care-message-actions">
        <span className="muted small">
          {patient ? value.length + '/2000' : 'In-app delivery. No SMS or WhatsApp is sent.'}
        </span>
        {rejected || (!enabled && !command) ? (
          <button
            key="availability"
            type="button"
            className="button button-secondary"
            disabled={checking}
            onClick={checkAvailability}
          >
            {rejected ? 'Edit draft' : checking ? 'Checking…' : 'Check availability'}
          </button>
        ) : (
          <button key="send" className="button button-primary" disabled={busy || !value.trim()}>
            {!patient && <Send size={16} />}
            {busy ? 'Sending…' : command ? 'Retry exact message' : 'Send message'}
            {patient && <ArrowUpRight size={17} />}
          </button>
        )}
      </div>
    </form>
  );
}
