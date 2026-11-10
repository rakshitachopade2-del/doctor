import { useState, useRef, useEffect, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, Check, CreditCard, FileText, Plus, Printer, Search, Trash2 } from 'lucide-react';
import type {
  Invoice,
  InvoiceDetail,
  KnowledgeArticle,
  ProcedureBillingItem,
} from '../../shared/operations';
import type { Patient } from '../../shared/types';
import { api, formatDate, money, useResource, useSession, useToast } from '../lib';
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
function paise(text: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error('Enter an amount with no more than two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function BillingPage() {
  const { session } = useSession();
  const staff = session.user?.role !== 'patient';
  const invoices = useResource<Invoice[]>('/api/invoices');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [params, setParams] = useSearchParams();
  const procedureId = params.get('procedure');
  const invoiceId = params.get('invoice');
  useEffect(() => {
    if (invoiceId) setSelected(invoiceId);
  }, [invoiceId]);
  const procedures = useResource<ProcedureBillingItem[]>(staff ? '/api/procedure-billing' : null);
  const [source, setSource] = useState<ProcedureBillingItem | null>(null);
  useEffect(() => {
    if (!staff || invoiceId || !procedureId || !procedures.data) return;
    const procedure = procedures.data.find((item) => item.id === procedureId);
    if (procedure?.invoiceId) setSelected(procedure.invoiceId);
    else if (procedure && procedure.status !== 'cancelled') {
      setSource(procedure);
      setCreating(true);
    }
  }, [staff, invoiceId, procedureId, procedures.data]);
  function closeSource() {
    setParams({}, { replace: true });
    setSource(null);
  }
  const rows = (invoices.data || []).filter(
    (i) =>
      (filter === 'all' || i.status === filter) &&
      `${i.number} ${i.patientName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const total = (invoices.data || []).reduce((n, i) => n + i.totalPaise, 0),
    paid = (invoices.data || []).reduce((n, i) => n + i.paidPaise, 0);
  return (
    <>
      <PageHeader
        eyebrow={staff ? 'CLINIC OPERATIONS' : 'YOUR CARE'}
        title={staff ? 'Billing & payments' : 'My invoices'}
        description={
          staff
            ? 'Clear, itemized invoices and a record of payments received.'
            : 'A transparent record of your clinic charges and payments.'
        }
        actions={
          staff ? (
            <button
              className="button button-primary"
              onClick={() => {
                closeSource();
                setCreating(true);
              }}
            >
              <Plus size={17} />
              Create invoice
            </button>
          ) : undefined
        }
      />
      {staff && procedureId && procedures.error && (
        <ErrorState message={procedures.error} retry={procedures.reload} />
      )}
      {staff &&
        procedureId &&
        procedures.data &&
        !procedures.data.some((item) => item.id === procedureId) && (
          <div className="notice notice-error">The linked procedure is not available.</div>
        )}
      {staff &&
        procedureId &&
        procedures.data?.some(
          (item) => item.id === procedureId && item.status === 'cancelled' && !item.invoiceId,
        ) && (
          <div className="notice">
            This procedure is cancelled. A new linked invoice cannot be created.
          </div>
        )}
      <div className="grid-3 billing-metrics">
        <Card>
          <span className="muted">Total invoiced</span>
          <strong>{money(total / 100)}</strong>
        </Card>
        <Card>
          <span className="muted">Payments recorded</span>
          <strong>{money(paid / 100)}</strong>
        </Card>
        <Card>
          <span className="muted">Balance due</span>
          <strong>{money((total - paid) / 100)}</strong>
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="Search invoices"
              placeholder="Patient or invoice number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="compact-select"
            aria-label="Invoice status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All invoices</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partially paid</option>
            <option value="paid">Paid</option>
          </select>
        </div>
        {invoices.loading ? (
          <Loading />
        ) : invoices.error ? (
          <ErrorState message={invoices.error} retry={invoices.reload} />
        ) : !rows.length ? (
          <EmptyState
            title="No invoices in this view"
            description={
              staff
                ? 'Create an invoice for a consultation, procedure, or clinic service.'
                : 'Your clinic invoices will appear here.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  {staff && <th>Patient</th>}
                  <th>Amount</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.number}</strong>
                      <small className="table-subtitle">{formatDate(i.createdAt)}</small>
                      {i.procedureTitle && (
                        <small className="table-subtitle">Procedure · {i.procedureTitle}</small>
                      )}
                    </td>
                    {staff && <td>{i.patientName}</td>}
                    <td>{money(i.totalPaise / 100)}</td>
                    <td>{money((i.totalPaise - i.paidPaise) / 100)}</td>
                    <td>
                      <Badge
                        tone={
                          i.status === 'paid'
                            ? 'green'
                            : i.status === 'partial'
                              ? 'amber'
                              : 'neutral'
                        }
                      >
                        {i.status === 'partial' ? 'Partially paid' : i.status}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="button button-secondary button-small"
                        onClick={() => setSelected(i.id)}
                      >
                        View invoice
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="notice">
        <CreditCard size={19} />
        <span>
          Payments are recorded by clinic staff after receipt. This workspace does not charge cards,
          process UPI, or connect to a payment gateway.
        </span>
      </div>
      {creating && (
        <InvoiceForm
          source={source}
          onClose={() => {
            setCreating(false);
            closeSource();
          }}
          onCreated={(id) => {
            setCreating(false);
            closeSource();
            setSelected(id);
            invoices.reload();
            procedures.reload();
          }}
        />
      )}
      {selected && (
        <InvoiceView
          id={selected}
          staff={staff}
          onClose={() => {
            setSelected(null);
            closeSource();
          }}
          onUpdated={invoices.reload}
        />
      )}
    </>
  );
}
function InvoiceForm({
  onClose,
  onCreated,
  source,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  source: ProcedureBillingItem | null;
}) {
  const patients = useResource<Patient[]>('/api/patients');
  const toast = useToast();
  const requestId = useRef(crypto.randomUUID());
  const [patientId, setPatientId] = useState(source?.patientId || '');
  const [procedureId, setProcedureId] = useState(source?.id || '');
  const procedures = useResource<ProcedureBillingItem[]>(
    patientId ? `/api/procedure-billing?patientId=${encodeURIComponent(patientId)}` : null,
  );
  const linked = procedures.data?.find((item) => item.id === procedureId) || source;
  const [items, setItems] = useState([
    { description: source?.title || '', quantity: '1', amount: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        requestId: requestId.current,
        patientId,
        ...(procedureId ? { procedureId } : {}),
        items: items.map((i) => ({
          description: i.description,
          quantity: Number(i.quantity),
          unitAmountPaise: paise(i.amount),
        })),
      };
      const result = await api<Invoice>('/api/invoices', { method: 'POST', body });
      toast('Invoice created.');
      onCreated(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function update(index: number, key: keyof (typeof items)[number], value: string) {
    setItems((old) => old.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  }
  return (
    <Modal title="Create an invoice" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {patients.error && <ErrorState message={patients.error} retry={patients.reload} />}
        <Field label="Patient">
          <select
            name="patientId"
            required
            value={patientId}
            disabled={!!source}
            onChange={(event) => {
              setPatientId(event.target.value);
              setProcedureId('');
              setItems([{ description: '', quantity: '1', amount: '' }]);
            }}
          >
            <option value="">Select a patient</option>
            {patients.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {procedures.error && <ErrorState message={procedures.error} retry={procedures.reload} />}
        {patientId && (
          <Field
            label="Link a procedure (optional)"
            hint="Each procedure can have one linked invoice. Set the agreed charges below; estimates are not charged automatically."
          >
            <select
              value={procedureId}
              disabled={!!source || procedures.loading}
              onChange={(event) => {
                const selected = procedures.data?.find((item) => item.id === event.target.value);
                setProcedureId(event.target.value);
                if (selected)
                  setItems([{ description: selected.title, quantity: '1', amount: '' }]);
              }}
            >
              <option value="">No procedure link</option>
              {procedures.data?.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={!!item.invoiceId || item.status === 'cancelled'}
                >
                  {item.title}
                  {item.invoiceNumber
                    ? ` · ${item.invoiceNumber}`
                    : item.status === 'cancelled'
                      ? ' · cancelled'
                      : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        {procedureId && linked && (
          <div className="notice">
            <span>
              Linked procedure: <strong>{linked.title}</strong>
              <br />
              Recorded estimate: {linked.estimatedCost || 'Not recorded'}. Creating an invoice
              records a charge; it does not record a received payment.
            </span>
          </div>
        )}
        {items.map((item, index) => (
          <div className="invoice-item-editor" key={index}>
            <div className="row between">
              <strong>Item {index + 1}</strong>
              {items.length > 1 && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove invoice item ${index + 1}`}
                  onClick={() => setItems((old) => old.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <Field label="Service or item">
              <input
                required
                maxLength={300}
                value={item.description}
                onChange={(e) => update(index, 'description', e.target.value)}
                placeholder="e.g. Dermatology consultation"
              />
            </Field>
            <div className="form-grid">
              <Field label="Quantity">
                <input
                  required
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  value={item.quantity}
                  onChange={(e) => update(index, 'quantity', e.target.value)}
                />
              </Field>
              <Field label="Unit price (₹)">
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  max="10000000"
                  value={item.amount}
                  onChange={(e) => update(index, 'amount', e.target.value)}
                />
              </Field>
            </div>
          </div>
        ))}
        <button
          className="button button-secondary"
          type="button"
          onClick={() =>
            setItems((old) => [...old, { description: '', quantity: '1', amount: '' }])
          }
        >
          <Plus size={15} />
          Add line item
        </button>
        <p className="muted">
          Confirm all amounts before creating the invoice. Tax calculation and refunds are not
          automated.
        </p>
        <button className="button button-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create invoice'}
        </button>
      </form>
    </Modal>
  );
}
function InvoiceView({
  id,
  staff,
  onClose,
  onUpdated,
}: {
  id: string;
  staff: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const detail = useResource<InvoiceDetail>(`/api/invoices/${id}`);
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  async function payment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      await api(`/api/invoices/${id}/payments`, {
        method: 'POST',
        body: {
          amountPaise: paise(values.amount),
          method: values.method,
          reference: values.reference,
          requestId,
        },
      });
      setRequestId(crypto.randomUUID());
      form.reset();
      await detail.reload();
      onUpdated();
      toast('Received payment recorded.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const d = detail.data;
  return (
    <Modal title={d ? `Invoice ${d.invoice.number}` : 'Invoice'} onClose={onClose}>
      {detail.loading ? (
        <Loading />
      ) : detail.error ? (
        <ErrorState message={detail.error} retry={detail.reload} />
      ) : (
        d && (
          <div className="stack invoice-document">
            {d.invoice.procedureId && (
              <div className="notice">
                <span>
                  Linked procedure: <strong>{d.invoice.procedureTitle}</strong>
                  {session.user?.role !== 'receptionist' && (
                    <>
                      <br />
                      <Link
                        className="text-link"
                        to={
                          staff
                            ? `/clinic/patients/${d.invoice.patientId}?tab=workup`
                            : '/my-care/record?tab=workflows'
                        }
                      >
                        Open procedure record →
                      </Link>
                    </>
                  )}
                </span>
              </div>
            )}
            <div className="row between">
              <div>
                <h2>{d.invoice.patientName}</h2>
                <p className="muted">Issued {formatDate(d.invoice.createdAt)}</p>
              </div>
              <Badge tone={d.invoice.status === 'paid' ? 'green' : 'amber'}>
                {d.invoice.status}
              </Badge>
            </div>
            <div className="table-wrap" role="region" aria-label="Invoice line items" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Qty</th>
                    <th>Unit price</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.invoice.items.map((item, i) => (
                    <tr key={i}>
                      <td>{item.description}</td>
                      <td>{item.quantity}</td>
                      <td>{money(item.unitAmountPaise / 100)}</td>
                      <td>{money((item.quantity * item.unitAmountPaise) / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="invoice-totals">
              <span>
                Total<strong>{money(d.invoice.totalPaise / 100)}</strong>
              </span>
              <span>
                Paid<strong>{money(d.invoice.paidPaise / 100)}</strong>
              </span>
              <span>
                Balance due
                <strong>{money((d.invoice.totalPaise - d.invoice.paidPaise) / 100)}</strong>
              </span>
            </div>
            {d.payments.length > 0 && (
              <div>
                <h3>Payment history</h3>
                {d.payments.map((p) => (
                  <div className="payment-row" key={p.id}>
                    <span>
                      <Check size={15} />
                      {money(p.amountPaise / 100)} · {p.method.toUpperCase()}
                    </span>
                    <small>
                      {formatDate(p.createdAt)}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </small>
                  </div>
                ))}
              </div>
            )}
            {staff && d.invoice.status !== 'paid' && (
              <form className="stack payment-form" onSubmit={payment}>
                <h3>Record a received payment</h3>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-grid">
                  <Field label="Amount received (₹)">
                    <input
                      type="number"
                      name="amount"
                      required
                      min="0.01"
                      step="0.01"
                      max={(d.invoice.totalPaise - d.invoice.paidPaise) / 100}
                    />
                  </Field>
                  <Field label="Payment method">
                    <select name="method">
                      <option value="cash">Cash</option>
                      <option value="upi">UPI</option>
                      <option value="card">Card</option>
                      <option value="bank">Bank transfer</option>
                    </select>
                  </Field>
                </div>
                <Field label="Reference / receipt number">
                  <input name="reference" maxLength={200} />
                </Field>
                <button className="button button-primary" disabled={busy}>
                  {busy ? 'Recording…' : 'Record received payment'}
                </button>
              </form>
            )}
            <button className="button button-secondary" onClick={() => window.print()}>
              <Printer size={16} />
              Print invoice
            </button>
          </div>
        )
      )}
    </Modal>
  );
}

export function LibraryPage({ manage = false }: { manage?: boolean }) {
  const articles = useResource<KnowledgeArticle[]>(
    manage ? '/api/knowledge/manage' : '/api/knowledge',
  );
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<KnowledgeArticle | 'new' | null>(null);
  const [reading, setReading] = useState<KnowledgeArticle | null>(null);
  const rows = (articles.data || []).filter((a) =>
    `${a.title} ${a.category} ${a.body}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className={manage ? '' : 'library-page'}>
      <PageHeader
        eyebrow={manage ? 'CLINIC KNOWLEDGE' : 'INFORMATION YOU CAN COME BACK TO'}
        title={manage ? 'Your knowledge library' : 'A little clarity for your care.'}
        description={
          manage
            ? 'Write, review, and publish information for your patients.'
            : 'Practical information reviewed and shared by your clinic.'
        }
        actions={
          manage ? (
            <button className="button button-primary" onClick={() => setEditing('new')}>
              <Plus size={16} />
              New article
            </button>
          ) : undefined
        }
      />
      <div className="library-search">
        <Search size={18} />
        <input
          aria-label="Search articles"
          placeholder="Search clinic information…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {articles.loading ? (
        <Loading />
      ) : articles.error ? (
        <ErrorState message={articles.error} retry={articles.reload} />
      ) : !rows.length ? (
        <Card>
          <EmptyState
            title="No articles yet"
            description={
              manage
                ? 'Create a draft, review it, and publish when it’s ready for patients.'
                : 'Your clinic will share useful information here. You can contact the clinic with any questions.'
            }
          />
        </Card>
      ) : (
        <div className="grid-3 knowledge-grid">
          {rows.map((a) => (
            <Card key={a.id}>
              <div className="row between">
                <span className="module-icon">
                  <BookOpen size={22} />
                </span>
                <Badge tone={a.status === 'published' ? 'green' : 'neutral'}>
                  {manage ? a.status : a.category}
                </Badge>
              </div>
              <h2>{a.title}</h2>
              <p className="muted article-preview">
                {a.body.slice(0, 180)}
                {a.body.length > 180 ? '…' : ''}
              </p>
              <small>Updated {formatDate(a.updatedAt)}</small>
              <div className="row">
                <button
                  className="button button-secondary button-small"
                  onClick={() => setReading(a)}
                >
                  Read article
                </button>
                {manage && (
                  <button
                    className="button button-ghost button-small"
                    onClick={() => setEditing(a)}
                  >
                    Edit & review
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <ArticleEditor
          article={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            articles.reload();
          }}
        />
      )}
      {reading && (
        <Modal title={reading.title} onClose={() => setReading(null)}>
          <div className="article-body">
            <Badge tone="green">{reading.category}</Badge>
            <p>{reading.body}</p>
            <small>
              {reading.status === 'published' ? 'Reviewed by' : 'Draft by'} {reading.authorName} ·
              Updated {formatDate(reading.updatedAt)}
            </small>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ArticleEditor({
  article,
  onClose,
  onSaved,
}: {
  article?: KnowledgeArticle;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [publish, setPublish] = useState(false);
  const savedId = useRef(article?.id);
  const toast = useToast();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      if (savedId.current)
        await api(`/api/knowledge/${savedId.current}`, {
          method: 'PATCH',
          body: { ...body, status: publish ? 'published' : 'draft' },
        });
      else {
        const created = await api<KnowledgeArticle>('/api/knowledge', { method: 'POST', body });
        savedId.current = created.id;
        if (publish)
          await api(`/api/knowledge/${created.id}`, {
            method: 'PATCH',
            body: { status: 'published' },
          });
      }
      toast(publish ? 'Article published to your clinic library.' : 'Draft saved for review.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={article ? 'Review clinic article' : 'Write a clinic article'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Field label="Title">
          <input name="title" required maxLength={200} defaultValue={article?.title} />
        </Field>
        <Field label="Category">
          <input
            name="category"
            required
            maxLength={100}
            placeholder="e.g. Visiting the clinic"
            defaultValue={article?.category}
          />
        </Field>
        <Field label="Article content">
          <textarea name="body" required maxLength={20000} rows={12} defaultValue={article?.body} />
        </Field>
        <label className="checkbox-field">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          <span>
            I have reviewed this information and approve it for the public clinic library.
          </span>
        </label>
        {article?.status === 'published' && !publish && (
          <p className="muted">
            Saving as a draft will remove this article from the public library until it is reviewed
            again.
          </p>
        )}
        <button className="button button-primary" disabled={busy}>
          <FileText size={16} />
          {busy ? 'Saving…' : publish ? 'Approve and publish' : 'Save draft'}
        </button>
      </form>
    </Modal>
  );
}
