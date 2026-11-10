import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  FileText,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { expenseCategories, type ClinicExpense, type ExpenseCategory } from '../../shared/insights';
import { ApiError, api, formatDate, today, useResource, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './expenses.css';

const categoryLabels: Record<ExpenseCategory, string> = {
  supplies: 'Supplies',
  equipment: 'Equipment',
  rent: 'Rent',
  utilities: 'Utilities',
  staff: 'Staff',
  services: 'Services',
  other: 'Other',
};
const currency = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
const timestamp = (date: string) =>
  new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be confirmed. Please try again.';
function amountInPaise(text: string) {
  const value = text.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error('Enter a rupee amount with no more than two decimal places, such as 1250.05.');
  const [whole, fraction = ''] = value.split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (paise < 1n || paise > 1_000_000_000n)
    throw new Error('Enter an amount from ₹0.01 to ₹1,00,00,000.00.');
  return Number(paise);
}
function validatePeriod(from: string, to: string) {
  const start = Date.parse(`${from}T12:00:00Z`),
    end = Date.parse(`${to}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  )
    return 'Choose a start and end date.';
  if (end < start) return 'The end date must be on or after the start date.';
  if ((end - start) / 86400000 + 1 > 366)
    return 'Choose a period of 366 days or fewer, including both dates.';
  return '';
}
type ExpensePayload = {
  incurredDate: string;
  category: ExpenseCategory;
  description: string;
  amountPaise: number;
  reference: string;
  requestId: string;
};
type ExpenseDraft = {
  requestId: string;
  incurredDate: string;
  category: ExpenseCategory;
  description: string;
  amount: string;
  reference: string;
  attempted: ExpensePayload | null;
};
const newDraft = (): ExpenseDraft => ({
  requestId: crypto.randomUUID(),
  incurredDate: today(),
  category: 'supplies',
  description: '',
  amount: '',
  reference: '',
  attempted: null,
});

export function ExpensesPage() {
  const initialFrom = `${today().slice(0, 7)}-01`;
  const [period, setPeriod] = useState({ from: initialFrom, to: today() });
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(today());
  const [rangeError, setRangeError] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ClinicExpense | null>(null);
  const query = new URLSearchParams({
    from: period.from,
    to: period.to,
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
  });
  const resource = useResource<ClinicExpense[]>(`/api/expenses?${query}`);
  const matches = useMemo(
    () =>
      (resource.data ?? []).filter((expense) =>
        `${expense.description} ${expense.reference} ${expense.createdByName}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [resource.data, search],
  );
  const recorded = matches.filter((expense) => expense.status === 'recorded');
  const voided = matches.filter((expense) => expense.status === 'voided');
  const totalsUnavailable = resource.loading || !!resource.error;
  function applyPeriod(event: FormEvent) {
    event.preventDefault();
    const error = validatePeriod(from, to);
    setRangeError(error);
    if (!error) setPeriod({ from, to });
  }
  function startEntry() {
    if (!draft) setDraft(newDraft());
    setCreating(true);
  }
  function created(expense: ClinicExpense) {
    setDraft(null);
    setCreating(false);
    setSelected(expense);
    const next = {
      from: expense.incurredDate < period.from ? expense.incurredDate : period.from,
      to: expense.incurredDate > period.to ? expense.incurredDate : period.to,
    };
    const visiblePeriod = validatePeriod(next.from, next.to)
      ? { from: expense.incurredDate, to: expense.incurredDate }
      : next;
    setPeriod(visiblePeriod);
    setFrom(visiblePeriod.from);
    setTo(visiblePeriod.to);
    setRangeError('');
    setStatus('');
    setCategory('');
    setSearch('');
    void resource.reload();
  }
  return (
    <div className="expense-workspace">
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Expense register"
        description="A clear record of costs incurred, with the original entry preserved."
        actions={
          <>
            <Link className="button button-secondary" to="/clinic/insights">
              Clinic insights <ArrowUpRight size={15} />
            </Link>
            <button className="button button-primary" onClick={startEntry}>
              <Plus size={16} /> {draft ? 'Resume expense entry' : 'Record expense'}
            </button>
          </>
        }
      />
      <div className="expense-intro">
        <span className="expense-intro-icon">
          <BookOpen size={23} />
        </span>
        <div>
          <h2>Record the cost. Keep the context.</h2>
          <p>
            Enter expenses incurred outside the platform. Saving records an expense; it does not
            make a payment, reconcile a bank account, or determine profit.
          </p>
        </div>
      </div>
      <Card className="expense-filter-card">
        <form className="expense-date-filter" onSubmit={applyPeriod}>
          <Field label="From date">
            <input
              type="date"
              required
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="To date">
            <input
              type="date"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <button className="button button-secondary">Apply dates</button>
          <button
            className="button button-ghost"
            type="button"
            disabled={resource.loading}
            onClick={resource.reload}
          >
            <RefreshCw size={15} /> Refresh register
          </button>
        </form>
        {rangeError && (
          <p className="form-error" role="alert">
            {rangeError}
          </p>
        )}
        <p className="expense-filter-note">
          Showing incurred dates {formatDate(period.from)} – {formatDate(period.to)} · Up to 366
          days per view · Asia/Kolkata
        </p>
      </Card>
      <div className="expense-metrics">
        <Card>
          <span>Recorded amount</span>
          <strong>
            {totalsUnavailable
              ? '—'
              : currency(recorded.reduce((sum, expense) => sum + expense.amountPaise, 0))}
          </strong>
          <p>Excludes voided entries in this view</p>
        </Card>
        <Card>
          <span>Entries in this view</span>
          <strong>{totalsUnavailable ? '—' : matches.length}</strong>
          <p>
            {totalsUnavailable
              ? resource.error
                ? 'Totals unavailable'
                : 'Loading totals…'
              : `${recorded.length} recorded · ${voided.length} voided`}
          </p>
        </Card>
        <Card>
          <span>Voided amount</span>
          <strong>
            {totalsUnavailable
              ? '—'
              : currency(voided.reduce((sum, expense) => sum + expense.amountPaise, 0))}
          </strong>
          <p>Retained in history, excluded from recorded totals</p>
        </Card>
      </div>
      <Card className="expense-register">
        <div className="expense-controls">
          <div className="segmented expense-status-filter">
            {[
              ['', 'All entries'],
              ['recorded', 'Recorded'],
              ['voided', 'Voided'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={status === value ? 'active' : ''}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="expense-search">
            <Search size={16} />
            <input
              aria-label="Search expenses"
              placeholder="Description, reference or author"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Field label="Expense category">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {expenseCategories.map((value) => (
                <option key={value} value={value}>
                  {categoryLabels[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : !matches.length ? (
          <EmptyState
            title="No expenses in this view"
            description="Adjust your dates or filters, or record an expense incurred by the clinic."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table expense-table">
              <thead>
                <tr>
                  <th>Incurred</th>
                  <th>Description & reference</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((expense) => (
                  <tr key={expense.id}>
                    <td>{formatDate(expense.incurredDate)}</td>
                    <td>
                      <strong>{expense.description}</strong>
                      <span className="table-sub">
                        {expense.reference || 'No reference recorded'}
                      </span>
                      <span className="table-sub">Entered by {expense.createdByName}</span>
                    </td>
                    <td>{categoryLabels[expense.category]}</td>
                    <td>
                      <strong>{currency(expense.amountPaise)}</strong>
                    </td>
                    <td>
                      <Badge tone={expense.status === 'recorded' ? 'green' : 'neutral'}>
                        {expense.status === 'recorded' ? 'Recorded' : 'Voided'}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="button button-secondary button-small"
                        onClick={() => setSelected(expense)}
                      >
                        View expense
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="expense-footnote">
        Recorded totals follow the current date, category, status, and search filters. Entries
        cannot be edited or deleted. Void an incorrect entry with a reason, then record the
        correction separately.
      </p>
      {creating && draft && (
        <ExpenseCreateModal
          draft={draft}
          onChange={setDraft}
          onClose={() => setCreating(false)}
          onCreated={created}
        />
      )}
      {selected && (
        <ExpenseDetailModal
          expense={selected}
          onClose={() => setSelected(null)}
          onUpdated={(expense) => {
            setSelected(expense);
            void resource.reload();
          }}
        />
      )}
    </div>
  );
}

function ExpenseCreateModal({
  draft,
  onChange,
  onClose,
  onCreated,
}: {
  draft: ExpenseDraft;
  onChange: (draft: ExpenseDraft) => void;
  onClose: () => void;
  onCreated: (expense: ClinicExpense) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const locked = busy || !!draft.attempted;
  function update<K extends keyof ExpenseDraft>(field: K, value: ExpenseDraft[K]) {
    onChange({ ...draft, [field]: value });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    let payload: ExpensePayload;
    try {
      payload = draft.attempted ?? {
        incurredDate: draft.incurredDate,
        category: draft.category,
        description: draft.description.trim(),
        amountPaise: amountInPaise(draft.amount),
        reference: draft.reference.trim(),
        requestId: draft.requestId,
      };
      if (!payload.description) throw new Error('Enter a description of the expense.');
      if (!payload.incurredDate || payload.incurredDate > today())
        throw new Error('Choose the date the cost was incurred, today or earlier.');
    } catch (problem) {
      setError(errorText(problem));
      return;
    }
    onChange({ ...draft, attempted: payload });
    setBusy(true);
    try {
      const expense = await api<ClinicExpense>('/api/expenses', { method: 'POST', body: payload });
      toast('Expense recorded. No payment was initiated.');
      onCreated(expense);
    } catch (problem) {
      setError(errorText(problem));
      if (problem instanceof ApiError && [400, 422].includes(problem.status))
        onChange({ ...draft, attempted: null });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Record a clinic expense"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack expense-entry-form" onSubmit={submit}>
        <p className="muted small">
          Enter an expense already incurred. The original amount, date, description, and reference
          stay in the register after saving.
        </p>
        <div className="form-grid">
          <Field label="Incurred date">
            <input
              required
              type="date"
              max={today()}
              value={draft.incurredDate}
              disabled={locked}
              onChange={(event) => update('incurredDate', event.target.value)}
            />
          </Field>
          <Field label="Category">
            <select
              value={draft.category}
              disabled={locked}
              onChange={(event) => update('category', event.target.value as ExpenseCategory)}
            >
              {expenseCategories.map((category) => (
                <option key={category} value={category}>
                  {categoryLabels[category]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea
            required
            rows={3}
            maxLength={300}
            value={draft.description}
            disabled={locked}
            onChange={(event) => update('description', event.target.value)}
            placeholder="What the clinic incurred this cost for"
          />
        </Field>
        <Field
          label="Amount (₹)"
          hint="Up to two decimal places. Minimum ₹0.01; maximum ₹1,00,00,000.00."
        >
          <input
            required
            type="text"
            inputMode="decimal"
            maxLength={16}
            value={draft.amount}
            disabled={locked}
            onChange={(event) => update('amount', event.target.value)}
            placeholder="1250.05"
          />
        </Field>
        <Field
          label="Reference / receipt number"
          hint="Optional. Retained with the original entry."
        >
          <input
            maxLength={200}
            value={draft.reference}
            disabled={locked}
            onChange={(event) => update('reference', event.target.value)}
          />
        </Field>
        {draft.attempted && !busy && (
          <div className="notice">
            This entry may already have reached the register. Retrying checks the same entry and
            keeps its amount and reference unchanged. You can close and resume this entry while you
            remain on this page.
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <div className="expense-form-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            {draft.attempted ? 'Close for now' : 'Cancel'}
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy
              ? 'Recording…'
              : draft.attempted
                ? 'Retry recording expense'
                : 'Save expense record'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ExpenseDetailModal({
  expense,
  onClose,
  onUpdated,
}: {
  expense: ClinicExpense;
  onClose: () => void;
  onUpdated: (expense: ClinicExpense) => void;
}) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [attemptedReason, setAttemptedReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function refreshStatus() {
    const entries = await api<ClinicExpense[]>(
      `/api/expenses?from=${expense.incurredDate}&to=${expense.incurredDate}`,
    );
    const current = entries.find((entry) => entry.id === expense.id);
    if (current) onUpdated(current);
    return current;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const note = attemptedReason ?? reason.trim();
    if (!note) {
      setError('Record why this expense is being voided.');
      return;
    }
    setAttemptedReason(note);
    setBusy(true);
    setError('');
    try {
      const updated = await api<ClinicExpense>(`/api/expenses/${expense.id}/void`, {
        method: 'POST',
        body: { reason: note },
      });
      onUpdated(updated);
      setVoiding(false);
      toast('Expense voided. Its original record and reason remain available.');
    } catch (problem) {
      setError(errorText(problem));
      if (problem instanceof ApiError && [400, 422].includes(problem.status))
        setAttemptedReason(null);
      if (problem instanceof ApiError && problem.status === 409) {
        try {
          const current = await refreshStatus();
          if (current?.status === 'voided') {
            setVoiding(false);
            toast('This expense has already been voided. Its recorded reason is shown.', 'error');
          }
        } catch {
          /* Keep the original request available for retry if refresh fails. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Expense record"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        <div className="expense-detail-heading">
          <span className="expense-detail-icon">
            <FileText size={22} />
          </span>
          <div>
            <h3>{expense.description}</h3>
            <p>
              {categoryLabels[expense.category]} · Incurred {formatDate(expense.incurredDate)}
            </p>
          </div>
          <Badge tone={expense.status === 'recorded' ? 'green' : 'neutral'}>
            {expense.status === 'recorded' ? 'Recorded' : 'Voided'}
          </Badge>
        </div>
        <div className="expense-original-amount">
          <span>Original amount</span>
          <strong>{currency(expense.amountPaise)}</strong>
        </div>
        <div className="expense-detail-field">
          <span>Original reference / receipt number</span>
          <p>{expense.reference || 'No reference recorded'}</p>
        </div>
        <div className="expense-history">
          <h3>Record history</h3>
          <article>
            <span className="expense-history-dot" />
            <div>
              <strong>Expense recorded</strong>
              <p>
                {expense.createdByName} · {timestamp(expense.createdAt)} IST
              </p>
              <small>
                Original amount, description, category, incurred date, and reference are retained.
              </small>
            </div>
          </article>
          {expense.void && (
            <article>
              <span className="expense-history-dot expense-history-void" />
              <div>
                <strong>Expense voided</strong>
                <p>
                  {expense.void.voidedByName} · {timestamp(expense.void.createdAt)} IST
                </p>
                <p className="expense-void-reason">{expense.void.reason}</p>
                <small>
                  Excluded from recorded-expense totals. This does not reverse a payment.
                </small>
              </div>
            </article>
          )}
        </div>
        {expense.status === 'recorded' && !voiding && (
          <button className="button button-secondary" onClick={() => setVoiding(true)}>
            Void this expense
          </button>
        )}
        {expense.status === 'recorded' && voiding && (
          <form className="stack expense-void-form" onSubmit={submit}>
            <div className="notice">
              Voiding cannot be undone. The original entry and your explanation remain visible.
              Record a separate expense if a correction is needed.
            </div>
            <Field label="Reason for voiding">
              <textarea
                required
                rows={3}
                maxLength={1000}
                value={reason}
                disabled={busy || attemptedReason !== null}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            {attemptedReason && !busy && (
              <p className="expense-footnote">
                Retrying checks the same void request and preserves its original reason.
              </p>
            )}
            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <div className="expense-form-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={busy || attemptedReason !== null}
                onClick={() => setVoiding(false)}
              >
                Keep expense
              </button>
              <button className="button button-danger" disabled={busy}>
                {busy ? 'Voiding…' : attemptedReason ? 'Retry void request' : 'Confirm void'}
              </button>
            </div>
          </form>
        )}
        {expense.status === 'voided' && (
          <div className="notice">
            <CalendarDays size={17} />
            <span>
              The original expense remains in this register. Voiding only removes it from
              recorded-expense totals.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
