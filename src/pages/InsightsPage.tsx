import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import type { ClinicInsights, InsightsDay } from '../../shared/insights';
import { formatDate, money, today, useResource } from '../lib';
import { Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import './insights.css';

type DateRange = { from: string; to: string };
const dayMs = 86_400_000;
function shift(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}
function realDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function rangeError({ from, to }: DateRange) {
  if (!realDate(from) || !realDate(to)) return 'Choose a valid start and end date.';
  if (to < from) return 'The end date must be on or after the start date.';
  if ((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / dayMs + 1 > 366)
    return 'Choose a range of 366 days or fewer, including both dates.';
  return '';
}
const amount = (paise: number) => money(paise / 100);
const number = (value: number) => value.toLocaleString('en-IN');
const statusLabels: Record<string, string> = {
  scheduled: 'Scheduled',
  'checked-in': 'Checked in',
  'in-consultation': 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'no-show': 'No show',
};
const categoryLabels: Record<string, string> = {
  supplies: 'Supplies',
  equipment: 'Equipment',
  rent: 'Rent',
  utilities: 'Utilities',
  staff: 'Staff',
  services: 'Services',
  other: 'Other',
};
const methodLabels: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  bank: 'Bank transfer',
};
const series = [
  { key: 'collectionsPaise', label: 'Recorded collections', currency: true, color: '#286455' },
  { key: 'expensesPaise', label: 'Recorded expenses', currency: true, color: '#87622c' },
  { key: 'invoicedPaise', label: 'Invoices issued', currency: true, color: '#4c6284' },
  { key: 'appointmentCount', label: 'Appointments', currency: false, color: '#517440' },
] as const;
type SeriesKey = (typeof series)[number]['key'];

export function InsightsPage() {
  const [params, setParams] = useSearchParams();
  const currentDate = today();
  const monthStart = `${currentDate.slice(0, 7)}-01`;
  const previousEnd = shift(monthStart, -1);
  const from = params.get('from') ?? monthStart;
  const to = params.get('to') ?? currentDate;
  const requestedError = rangeError({ from, to });
  const report = useResource<ClinicInsights>(
    requestedError
      ? null
      : `/api/insights?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [validation, setValidation] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
    setValidation('');
    setExportError('');
    setExporting(false);
    return () => {
      exportRequest.current?.abort();
      exportRequest.current = null;
    };
  }, [from, to]);
  const presets = [
    { label: 'Month to date', from: monthStart, to: currentDate },
    { label: 'Last 7 days', from: shift(currentDate, -6), to: currentDate },
    { label: 'Last 30 days', from: shift(currentDate, -29), to: currentDate },
    { label: 'Previous month', from: `${previousEnd.slice(0, 7)}-01`, to: previousEnd },
  ];
  function selectRange(range: DateRange) {
    const error = rangeError(range);
    setValidation(error);
    if (!error) {
      if (range.from !== from || range.to !== to) {
        exportRequest.current?.abort();
        exportRequest.current = null;
        setExporting(false);
        setExportError('');
      }
      setDraftFrom(range.from);
      setDraftTo(range.to);
      setParams({ from: range.from, to: range.to });
    }
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    selectRange({ from: draftFrom, to: draftTo });
  }
  async function exportCsv() {
    if (!report.data || requestedError || report.error || report.loading || exportRequest.current)
      return;
    const snapshot = report.data;
    const controller = new AbortController();
    exportRequest.current = controller;
    const current = () => exportRequest.current === controller && !controller.signal.aborted;
    setExporting(true);
    setExportError('');
    try {
      const response = await fetch(
        `/api/insights/export?from=${encodeURIComponent(snapshot.from)}&to=${encodeURIComponent(snapshot.to)}`,
        { credentials: 'same-origin', signal: controller.signal },
      );
      if (!current()) return;
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(problem?.error || 'The CSV could not be downloaded. Please try again.');
      }
      if (!response.headers.get('content-type')?.includes('text/csv'))
        throw new Error('The server did not return a CSV file. Please try again.');
      const blob = await response.blob();
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `clinic-insights-${snapshot.from}-to-${snapshot.to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (current())
        setExportError(
          problem instanceof Error ? problem.message : 'Unable to download this report.',
        );
    } finally {
      if (current()) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
  }
  return (
    <div className="insights-page">
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Clinic insights"
        description="Appointment activity and recorded finances, with the time period made clear."
        actions={
          <>
            <Link className="button button-secondary" to="/clinic/expenses">
              Expense ledger <ArrowRight size={16} />
            </Link>
            <button
              className="button button-primary"
              disabled={
                !report.data || report.loading || !!report.error || !!requestedError || exporting
              }
              onClick={exportCsv}
            >
              <ArrowDownToLine size={16} />
              {exporting ? 'Preparing CSV…' : 'Export aggregate CSV'}
            </button>
          </>
        }
      />
      <Card className="insights-range-card">
        <div className="insights-range-heading">
          <div>
            <h2>Choose a reporting period</h2>
            <p>Inclusive dates · Asia/Kolkata · Up to 366 days</p>
          </div>
          <CalendarDays size={22} />
        </div>
        <div className="insights-presets" role="group" aria-label="Reporting period presets">
          {presets.map((preset) => (
            <button
              key={preset.label}
              className={`button button-small ${preset.from === from && preset.to === to ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={preset.from === from && preset.to === to}
              onClick={() => selectRange(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <form className="insights-range-form" onSubmit={apply}>
          <Field label="Report start date">
            <input
              type="date"
              required
              value={draftFrom}
              onChange={(event) => setDraftFrom(event.target.value)}
            />
          </Field>
          <Field label="Report end date">
            <input
              type="date"
              required
              value={draftTo}
              onChange={(event) => setDraftTo(event.target.value)}
            />
          </Field>
          <button className="button button-secondary" type="submit">
            Apply dates
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={report.loading || !!requestedError}
            onClick={report.reload}
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </form>
        {(validation || requestedError) && (
          <p className="notice notice-error" role="alert">
            {validation || requestedError}
          </p>
        )}
        {!validation && !requestedError && (draftFrom !== from || draftTo !== to) && (
          <p className="insights-help">Apply dates to update the report below.</p>
        )}
      </Card>
      {exportError && (
        <div className="notice notice-error" role="alert">
          {exportError}
        </div>
      )}
      {requestedError ? (
        <EmptyState
          title="Choose a valid reporting period"
          description="Your date selection must include 366 days or fewer."
        />
      ) : report.loading ? (
        <Loading />
      ) : report.error ? (
        <ErrorState message={report.error} retry={report.reload} />
      ) : report.data ? (
        <InsightsReport key={`${report.data.from}:${report.data.to}`} data={report.data} />
      ) : null}
    </div>
  );
}

function InsightsReport({ data }: { data: ClinicInsights }) {
  const totals = data.totals;
  const empty =
    !totals.appointmentCount &&
    !totals.invoiceCount &&
    !totals.paymentCount &&
    !totals.expenseCount;
  return (
    <>
      <div className="insights-period-summary">
        <strong>
          {formatDate(data.from)} – {formatDate(data.to)}
        </strong>
        <span>
          Updated{' '}
          {new Date(data.generatedAt).toLocaleString('en-IN', {
            timeZone: data.timezone,
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          IST
        </span>
      </div>
      {empty && (
        <div className="notice">
          No appointments, invoices, payment records or recorded expenses match this period. The
          report shows zero activity.
        </div>
      )}
      <div className="insights-metrics">
        <Metric
          label="Invoices issued"
          value={amount(totals.invoicedPaise)}
          detail={`Current corrected charges for ${number(totals.invoiceCount)} invoices originally issued during this period.`}
        />
        <Metric
          label="Recorded collections"
          value={amount(totals.collectionsPaise)}
          detail={`${number(totals.paymentCount)} non-reversed received-payment entries originally recorded during this period.`}
        />
        <Metric
          label="Recorded expenses"
          value={amount(totals.expensesPaise)}
          detail={`${number(totals.expenseCount)} expenses incurred during this period; currently voided entries excluded.`}
        />
        <Metric
          label="Outstanding on period invoices"
          value={amount(totals.issuedInvoiceOutstandingPaise)}
          detail="Current corrected balance of invoices originally issued in this period, including later payment records and reversals of erroneous entries."
        />
      </div>
      <div className="insights-scope-note">
        <strong>These amounts have different date scopes.</strong>
        <p>
          Current corrected invoice amounts use the original issue date. Collections exclude
          reversed erroneous entries and use each payment’s original recording date; actual receipt
          dates are not stored separately. A reversal corrects a recorded entry and does not return
          money. Expenses use incurred dates. Outstanding is a current balance, not a balance at
          period end. These records do not measure profit or reconcile a bank account.
        </p>
      </div>
      <div className="insights-visit-summary">
        <div>
          <strong>{number(totals.appointmentCount)}</strong>
          <span>Appointments dated in this period</span>
        </div>
        <div>
          <strong>{number(totals.patientsWithAppointments)}</strong>
          <span>Distinct patients with appointments</span>
        </div>
        <p>
          Includes all appointment statuses, including cancellations. Status is the current recorded
          status.
        </p>
      </div>
      <DailyInsights data={data.daily} />
      <div className="insights-breakdowns">
        <CountBreakdown
          title="Appointments by status"
          description="Current status of appointments dated in the period."
          rows={data.appointmentsByStatus.map((row) => ({
            label: statusLabels[row.status] ?? row.status,
            count: row.count,
          }))}
        />
        <CountBreakdown
          title="Appointments by consultation mode"
          description="Appointment date determines inclusion."
          rows={data.appointmentsByMode.map((row) => ({
            label: row.mode === 'online' ? 'Online' : 'In person',
            count: row.count,
          }))}
        />
        <MoneyBreakdown
          title="Collections by method"
          description="Non-reversed payment entries, by their original recording date."
          rows={data.collectionsByMethod.map((row) => ({
            label: methodLabels[row.method] ?? row.method,
            count: row.count,
            amountPaise: row.amountPaise,
          }))}
          countLabel="Payments"
        />
        <MoneyBreakdown
          title="Expenses by category"
          description="Incurred dates in the period, excluding currently voided entries."
          rows={data.expensesByCategory.map((row) => ({
            label: categoryLabels[row.category] ?? row.category,
            count: row.count,
            amountPaise: row.amountPaise,
          }))}
          countLabel="Expenses"
        />
      </div>
      <p className="insights-footnote">
        Aggregate records for clinic administration. Appointment counts and status changes do not
        measure treatment quality or clinical outcomes. Export contains aggregate figures only.
      </p>
    </>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div role="group" aria-label={label}>
      <Card className="insights-metric">
        <h2>{label}</h2>
        <strong className="insights-metric-value">{value}</strong>
        <p>{detail}</p>
      </Card>
    </div>
  );
}

function DailyInsights({ data }: { data: InsightsDay[] }) {
  const [metric, setMetric] = useState<SeriesKey>('collectionsPaise');
  const [page, setPage] = useState(0);
  const selected = series.find((value) => value.key === metric)!;
  const values = data.map((day) => day[metric]);
  const maximum = Math.max(0, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const formatValue = (value: number) => (selected.currency ? amount(value) : number(value));
  const pageSize = 14;
  const shown = data.slice(page * pageSize, (page + 1) * pageSize);
  const chartId = useId();
  const x = (index: number) => (data.length === 1 ? 300 : 8 + (index / (data.length - 1)) * 584);
  const y = (value: number) => 172 - (maximum ? (value / maximum) * 160 : 0);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  return (
    <Card className="insights-daily-card">
      <div className="insights-daily-heading">
        <div>
          <span className="eyebrow">DAY BY DAY</span>
          <h2>Daily activity</h2>
          <p className="insights-help">
            Each point represents one calendar day. Exact values are in the table below.
          </p>
        </div>
        <Field label="Chart measure">
          <select value={metric} onChange={(event) => setMetric(event.target.value as SeriesKey)}>
            {series.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="insights-chart-summary">
        <span>
          {selected.label} · {selected.currency ? 'Indian rupees' : 'Count'}
        </span>
        <strong>Period total {formatValue(total)}</strong>
      </div>
      {maximum ? (
        <div className="insights-chart">
          <div className="insights-chart-scale">
            <span>Daily maximum {formatValue(maximum)}</span>
            <span>Baseline {selected.currency ? '₹0' : '0'}</span>
          </div>
          <svg
            viewBox="0 0 600 180"
            preserveAspectRatio="none"
            role="img"
            aria-labelledby={`${chartId}-title`}
            aria-describedby={`${chartId}-description`}
          >
            <title id={`${chartId}-title`}>{selected.label} by day</title>
            <desc id={`${chartId}-description`}>
              {data.length} days. Period total {formatValue(total)}; highest daily value{' '}
              {formatValue(maximum)}. Exact daily values follow in the table.
            </desc>
            {[12, 52, 92, 132, 172].map((value) => (
              <line
                key={value}
                x1="0"
                x2="600"
                y1={value}
                y2={value}
                stroke="#dee7d7"
                strokeWidth="1"
              />
            ))}
            <polyline
              points={points}
              fill="none"
              stroke={selected.color}
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            {data.length <= 31 &&
              values.map((value, index) => (
                <circle
                  key={data[index].date}
                  cx={x(index)}
                  cy={y(value)}
                  r="3.5"
                  fill={selected.color}
                >
                  <title>
                    {formatDate(data[index].date)}: {formatValue(value)}
                  </title>
                </circle>
              ))}
          </svg>
          <div className="insights-chart-dates">
            <span>{formatDate(data[0].date)}</span>
            <span>{formatDate(data[data.length - 1].date)}</span>
          </div>
        </div>
      ) : (
        <EmptyState
          title={`No ${selected.label.toLowerCase()} in this period`}
          description="All daily values for this measure are zero. Choose another measure or reporting period."
        />
      )}
      <div
        className="insights-daily-table"
        role="region"
        aria-label="Daily metrics table; scroll horizontally for all columns"
        tabIndex={0}
      >
        <table>
          <caption>Daily metrics · Indian rupees for financial amounts</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Appointments</th>
              <th scope="col">Completed</th>
              <th scope="col">Cancelled</th>
              <th scope="col">No show</th>
              <th scope="col">Invoiced</th>
              <th scope="col">Collections</th>
              <th scope="col">Expenses</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((day) => (
              <tr key={day.date}>
                <th scope="row">{formatDate(day.date)}</th>
                <td>{number(day.appointmentCount)}</td>
                <td>{number(day.completedAppointments)}</td>
                <td>{number(day.cancelledAppointments)}</td>
                <td>{number(day.noShowAppointments)}</td>
                <td>{amount(day.invoicedPaise)}</td>
                <td>{amount(day.collectionsPaise)}</td>
                <td>{amount(day.expensesPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="insights-table-paging">
        <span>
          Days {data.length ? page * pageSize + 1 : 0}–
          {Math.min((page + 1) * pageSize, data.length)} of {data.length}
        </span>
        {data.length > pageSize && (
          <div>
            <button
              className="button button-ghost button-small"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={15} />
              Earlier days
            </button>
            <button
              className="button button-ghost button-small"
              disabled={(page + 1) * pageSize >= data.length}
              onClick={() => setPage((value) => value + 1)}
            >
              Later days
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function CountBreakdown({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: { label: string; count: number }[];
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Card className="insights-breakdown">
      <h2>{title}</h2>
      <p className="insights-help">{description}</p>
      <dl className="insights-count-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>
              {row.label}
              <span aria-hidden="true" className="insights-count-track">
                <span style={{ width: `${(row.count / maximum) * 100}%` }} />
              </span>
            </dt>
            <dd>{number(row.count)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
function MoneyBreakdown({
  title,
  description,
  rows,
  countLabel,
}: {
  title: string;
  description: string;
  rows: { label: string; count: number; amountPaise: number }[];
  countLabel: string;
}) {
  return (
    <Card className="insights-breakdown">
      <h2>{title}</h2>
      <p className="insights-help">{description}</p>
      <div className="insights-breakdown-table">
        <table>
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{countLabel === 'Payments' ? 'Method' : 'Category'}</th>
              <th scope="col">{countLabel}</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{number(row.count)}</td>
                <td>{amount(row.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
