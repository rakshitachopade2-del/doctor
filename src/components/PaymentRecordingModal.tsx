import { useEffect, useRef, useState } from 'react';
import type { InvoiceDetail } from '../../shared/operations';
import type {
  PaymentRecordingCommand,
  PaymentRecordingReceipt,
} from '../../shared/payment-recording';
import { api, ApiError, money, useSession } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { Modal } from './ui';

export interface ReviewedPayment {
  invoiceId: string;
  invoiceNumber: string;
  patientName: string;
  totalPaise: number;
  beforePaidPaise: number;
  previousPaymentIds: string[];
  command: PaymentRecordingCommand;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function confirmedPayment(
  value: unknown,
  attempt: ReviewedPayment,
  actorId: string,
): PaymentRecordingReceipt | null {
  if (!object(value) || !object(value.receipt)) return null;
  const receipt = value.receipt,
    payment = receipt.payment,
    command = attempt.command;
  if (
    !object(payment) ||
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.invoiceId !== attempt.invoiceId ||
    receipt.patientId !== command.patientId ||
    receipt.expectedRevision !== command.expectedRevision ||
    receipt.invoiceNumber !== attempt.invoiceNumber ||
    receipt.totalPaise !== attempt.totalPaise ||
    receipt.beforePaidPaise !== attempt.beforePaidPaise ||
    receipt.afterPaidPaise !== attempt.beforePaidPaise + command.amountPaise ||
    payment.invoiceId !== attempt.invoiceId ||
    payment.amountPaise !== command.amountPaise ||
    payment.method !== command.method ||
    payment.reference !== command.reference ||
    typeof payment.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payment.id) ||
    attempt.previousPaymentIds.includes(payment.id) ||
    typeof payment.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(payment.createdAt)) ||
    new Date(payment.createdAt).toISOString() !== payment.createdAt
  )
    return null;
  return {
    requestId: receipt.requestId,
    actorId: receipt.actorId,
    invoiceId: receipt.invoiceId,
    patientId: receipt.patientId,
    expectedRevision: receipt.expectedRevision,
    invoiceNumber: receipt.invoiceNumber,
    totalPaise: receipt.totalPaise,
    beforePaidPaise: receipt.beforePaidPaise,
    afterPaidPaise: receipt.afterPaidPaise,
    payment: {
      id: payment.id,
      createdAt: payment.createdAt,
      invoiceId: payment.invoiceId,
      amountPaise: payment.amountPaise,
      method: command.method,
      reference: payment.reference,
    },
  };
}

function rejectionMessage(problem: unknown, attempt: ReviewedPayment, actorId: string) {
  if (!(problem instanceof ApiError) || problem.status !== 409 || !object(problem.responseData))
    return '';
  const value = problem.responseData,
    command = value.command;
  return value.code === 'PAYMENT_NOT_RECORDED' &&
    value.actorId === actorId &&
    value.invoiceId === attempt.invoiceId &&
    typeof value.message === 'string' &&
    !!value.message.trim() &&
    object(command) &&
    Object.keys(command).length === Object.keys(attempt.command).length &&
    Object.entries(attempt.command).every(([key, expected]) => command[key] === expected)
    ? value.message
    : '';
}

export function PaymentRecordingModal({
  attempt,
  onEdit,
  onRefresh,
  onClose,
  onConfirmed,
  onOpenCurrent,
  checkDetail,
}: {
  attempt: ReviewedPayment;
  onEdit: () => void;
  onRefresh: (source: InvoiceDetail) => void;
  onClose: () => void;
  onConfirmed: () => void;
  onOpenCurrent: () => void;
  checkDetail: (value: unknown, id: string) => InvoiceDetail;
}) {
  const { session } = useSession();
  const actorId = session.user?.id;
  const { paymentRecording } = usePendingCareSubmissions();
  const [phase, setPhase] = useState<'review' | 'pending' | 'rejected' | 'saved'>(
    paymentRecording.current ? 'pending' : 'review',
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [saved, setSaved] = useState<PaymentRecordingReceipt | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false),
    dismissed = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const capture = useAppointmentBookingGuard();
  const { command, invoiceId, invoiceNumber, patientName } = attempt;
  useEffect(() => {
    heading.current?.focus();
  }, [phase]);
  function close() {
    dismissed.current = true;
    onClose();
  }
  async function record() {
    if (
      !actorId ||
      working.current ||
      dismissed.current ||
      !(phase === 'pending'
        ? paymentRecording.current === attempt
        : phase === 'review' && acknowledged && !paymentRecording.current)
    )
      return;
    const origin = capture();
    const current = () => !dismissed.current && origin() && paymentRecording.current === attempt;
    working.current = true;
    paymentRecording.current = attempt;
    setBusy(true);
    setPhase('pending');
    setMessage('');
    try {
      const value = await api<unknown>(
        `/api/invoices/${encodeURIComponent(invoiceId)}/payments/record`,
        {
          method: 'POST',
          body: command,
          isCurrent: current,
        },
      );
      if (!current()) return;
      const entry = confirmedPayment(value, attempt, actorId);
      if (!entry) return;
      paymentRecording.current = null;
      setSaved(entry);
      setPhase('saved');
      onConfirmed();
    } catch (problem) {
      if (!current()) return;
      const reason = rejectionMessage(problem, attempt, actorId);
      if (reason) {
        setMessage(reason);
        setPhase('rejected');
      }
    } finally {
      if (!dismissed.current && origin()) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    if (
      phase !== 'rejected' ||
      working.current ||
      dismissed.current ||
      paymentRecording.current !== attempt
    )
      return;
    const origin = capture();
    const current = () => !dismissed.current && origin() && paymentRecording.current === attempt;
    working.current = true;
    setBusy(true);
    try {
      const latest = checkDetail(
        await api<unknown>('/api/invoices/' + encodeURIComponent(invoiceId), {
          isCurrent: current,
        }),
        invoiceId,
      );
      if (!current()) return;
      if (latest.invoice.patientId !== command.patientId || latest.invoice.number !== invoiceNumber)
        throw new Error('The invoice details could not be verified. Refresh to try again.');
      dismissed.current = true;
      paymentRecording.current = null;
      onRefresh(latest);
    } catch (problem) {
      if (current())
        setMessage(problem instanceof Error ? problem.message : 'Could not refresh this invoice.');
    } finally {
      if (current()) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  const title =
    phase === 'review'
      ? 'Review received payment'
      : phase === 'saved'
        ? 'Payment recorded'
        : phase === 'rejected'
          ? 'Payment not recorded'
          : 'Payment confirmation pending';
  const payment = saved?.payment ?? command;
  const totalPaise = saved?.totalPaise ?? attempt.totalPaise;
  const balanceBefore = totalPaise - (saved?.beforePaidPaise ?? attempt.beforePaidPaise);
  const balanceAfter = saved
    ? totalPaise - saved.afterPaidPaise
    : balanceBefore - command.amountPaise;
  const methods = { cash: 'Cash', card: 'Card', upi: 'UPI', bank: 'Bank transfer' };
  return (
    <Modal title="Received payment" onClose={close}>
      <div className="stack billing-payment-review">
        <h3 ref={heading} tabIndex={-1}>
          {title}
        </h3>
        <p>
          <strong>{saved?.invoiceNumber ?? invoiceNumber}</strong> · {patientName}
        </p>
        {phase === 'pending' && (
          <p role="status">
            {busy
              ? 'Waiting for the recording confirmation.'
              : 'Retry this exact entry to recover its confirmation. This signed-in tab keeps the request when you close this window or leave Billing. Reloading or signing out clears it.'}
          </p>
        )}
        {phase === 'rejected' && <p role="alert">{message}</p>}
        {phase === 'saved' && saved && (
          <p>
            Recorded on{' '}
            <time dateTime={saved.payment.createdAt}>
              {new Date(saved.payment.createdAt).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'medium',
              })}{' '}
              IST
            </time>
            . Entry {saved.payment.id}.
          </p>
        )}
        <dl>
          <div>
            <dt>Amount received</dt>
            <dd>{money(payment.amountPaise / 100)}</dd>
          </div>
          <div>
            <dt>Payment method</dt>
            <dd>{methods[payment.method]}</dd>
          </div>
          <div>
            <dt>Reference / receipt number</dt>
            <dd>{payment.reference || 'No reference recorded'}</dd>
          </div>
          <div>
            <dt>Invoice total at review</dt>
            <dd>{money(totalPaise / 100)}</dd>
          </div>
          <div>
            <dt>Balance before payment</dt>
            <dd>{money(balanceBefore / 100)}</dd>
          </div>
          <div>
            <dt>{phase === 'saved' ? 'Balance after recording' : 'Balance if recorded'}</dt>
            <dd>{money(balanceAfter / 100)}</dd>
          </div>
        </dl>
        {phase === 'review' && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I confirm this money was already received outside Derma.
          </label>
        )}
        <div className="modal-actions">
          {phase === 'review' ? (
            <button className="button button-secondary" onClick={onEdit}>
              Edit payment
            </button>
          ) : (
            <button className="button button-secondary" onClick={close}>
              {phase === 'saved' ? 'Close confirmation' : 'Close for now'}
            </button>
          )}
          {phase === 'saved' ? (
            <button className="button button-primary" onClick={onOpenCurrent}>
              Open current invoice
            </button>
          ) : phase === 'rejected' ? (
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Refreshing…' : 'Review current invoice'}
            </button>
          ) : (
            <button
              className="button button-primary"
              disabled={busy || (phase === 'review' && !acknowledged)}
              onClick={() => void record()}
            >
              {busy
                ? 'Recording…'
                : phase === 'pending'
                  ? 'Retry exact payment'
                  : 'Record received payment'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
