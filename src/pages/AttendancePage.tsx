import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { Clock3, Download, History, LogIn, LogOut, Pencil, Plus, RefreshCw } from 'lucide-react';
import type {
  AttendanceContext,
  AttendanceDetail,
  AttendanceOperation,
  AttendanceShift,
  AttendanceStaff,
} from '../../shared/attendance';
import { api, ApiError, today, useSession, useToast } from '../lib';
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
import { Pagination } from '../components/Pagination';
import {
  attendanceDay,
  attendanceDuration,
  attendanceFailure,
  attendanceInput,
  attendanceParts,
  attendancePeriod,
  attendanceStamp,
  attendanceState,
  checkedAttendanceContext,
  checkedAttendanceDetail,
  checkedAttendanceMutation,
  checkedAttendanceReport,
  checkedAttendanceStaff,
  useAttendanceData,
  type AttendanceAttempt,
  type AttendanceFilters,
} from './attendance-helpers';
import './attendance.css';

const operationLabels: Record<AttendanceOperation, string> = {
  'clock-in': 'Clock in',
  'clock-out': 'Clock out',
  'manual-entry': 'Record missed attendance',
  correction: 'Correct attendance entry',
  void: 'Void mistaken entry',
};
const statusLabels = { open: 'Open', closed: 'Closed', voided: 'Voided' };
type Draft = {
  operation: AttendanceOperation;
  userId: string;
  shiftId: string | null;
  source: AttendanceContext | AttendanceDetail | null;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
  confirmed: boolean;
  requestId: string;
  attempt: AttendanceAttempt | null;
  phase: 'editing' | 'uncertain' | 'conflict';
  error: string;
  reviewed: AttendanceContext | AttendanceDetail | null;
};
const sourceShift = (source: Draft['source']) =>
  source && ('shift' in source ? source.shift : source.openShift);
function makeDraft(operation: AttendanceOperation, source: Draft['source'], userId: string): Draft {
  const shift = sourceShift(source),
    start = shift ? attendanceParts(shift.startedAt) : null;
  const end = shift?.endedAt ? attendanceParts(shift.endedAt) : null;
  return {
    operation,
    userId,
    shiftId: operation === 'clock-in' || operation === 'manual-entry' ? null : (shift?.id ?? null),
    source,
    startDate: start?.date ?? today(),
    startTime: start?.time ?? '',
    endDate: end?.date ?? start?.date ?? today(),
    endTime: end?.time ?? '',
    reason: '',
    confirmed: false,
    requestId: crypto.randomUUID(),
    attempt: null,
    phase: 'editing',
    error: '',
    reviewed: null,
  };
}
function StateSummary({ shift }: { shift: AttendanceShift }) {
  return (
    <div className="attendance-interval">
      <div>
        <span>Start · IST</span>
        <strong>{attendanceStamp(shift.startedAt)}</strong>
      </div>
      <div>
        <span>End · IST</span>
        <strong>{shift.endedAt ? attendanceStamp(shift.endedAt) : 'No clock-out recorded'}</strong>
      </div>
      <div>
        <span>Recorded time</span>
        <strong>
          {shift.recordedSeconds === null
            ? 'Not included in totals'
            : attendanceDuration(shift.recordedSeconds)}
        </strong>
      </div>
    </div>
  );
}
function HistoryView({ detail }: { detail: AttendanceDetail }) {
  const original = detail.events.find((event) => event.before === null)!;
  return (
    <div className="attendance-history">
      <section className="attendance-original">
        <h3>Original entry</h3>
        <p>
          {detail.shift.staffName} · {detail.shift.staffRole} ·{' '}
          {detail.shift.source === 'clock' ? 'Self clocking' : 'Administrator recorded'}
        </p>
        <p>
          {attendanceStamp(original.after.startedAt)} →{' '}
          {original.after.endedAt
            ? attendanceStamp(original.after.endedAt)
            : 'Open when first recorded'}{' '}
          · IST
        </p>
        <p className="muted small">
          Recorded by {original.createdByName} on {attendanceStamp(original.createdAt)} IST
        </p>
      </section>
      <h3>Entry history</h3>
      {detail.events.map((event) => (
        <article className="attendance-event" key={event.id}>
          <div className="attendance-event-title">
            <strong>{operationLabels[event.operation]}</strong>
            <span>{attendanceStamp(event.createdAt)} IST</span>
          </div>
          <p>
            {event.createdByName} · {event.createdByRole}
          </p>
          <p className="attendance-reason">{event.reason}</p>
          {event.before && (
            <details>
              <summary>View before and after</summary>
              <dl className="attendance-history-states">
                {[
                  ['Before', event.before],
                  ['After', event.after],
                ].map(([label, value]) => {
                  const state = value as typeof event.after;
                  return (
                    <div key={label as string}>
                      <dt>{label as string}</dt>
                      <dd>
                        {attendanceStamp(state.startedAt)} →{' '}
                        {state.endedAt ? attendanceStamp(state.endedAt) : 'Open'} · IST
                        {state.voided ? ' · Voided' : ''}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
function ContextSummary({ source }: { source: AttendanceContext | AttendanceDetail }) {
  if ('shift' in source)
    return (
      <>
        <strong>{source.shift.staffName}</strong>
        <Badge>{statusLabels[source.shift.status]}</Badge>
        <StateSummary shift={source.shift} />
        <HistoryView detail={source} />
      </>
    );
  return (
    <>
      <strong>
        {source.staff.name} · {source.staff.role}
      </strong>
      <p>
        {source.staff.active
          ? 'Active staff account'
          : 'Inactive staff account; administrators can repair its attendance history.'}
      </p>
      {source.openShift ? (
        <StateSummary shift={source.openShift} />
      ) : (
        <p>No open attendance entry.</p>
      )}
      <p className="muted small">Checked at {attendanceStamp(source.serverNow)} IST</p>
    </>
  );
}
function ShiftStatus({ shift }: { shift: AttendanceShift }) {
  return (
    <Badge
      tone={shift.status === 'closed' ? 'green' : shift.status === 'open' ? 'amber' : 'neutral'}
    >
      {statusLabels[shift.status]}
    </Badge>
  );
}

export function AttendancePage() {
  const { session } = useSession();
  const user = session.user!,
    admin = user.role === 'admin';
  const [params, setParams] = useSearchParams(),
    location = useLocation();
  const navigationType = useNavigationType();
  const ownFilterNavigations = useRef(new Set<string>());
  const view = admin && params.get('view') === 'team' ? 'team' : 'mine';
  const from = params.get('from') ?? `${today().slice(0, 7)}-01`,
    to = params.get('to') ?? today();
  const status = (
    ['open', 'closed', 'voided'].includes(params.get('status') ?? '') ? params.get('status') : 'all'
  ) as AttendanceFilters['status'];
  const userId = view === 'mine' ? user.id : params.get('staff') || null;
  const requestedPage = Number(params.get('page') ?? 1);
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000
      ? requestedPage
      : 1;
  const filters: AttendanceFilters = { from, to, userId, status };
  const filterKey = JSON.stringify(filters);
  const [form, setForm] = useState({ from, to, staff: userId ?? '', status });
  const [formError, setFormError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null),
    [editorOpen, setEditorOpen] = useState(false);
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('');
  const [detailGeneration, setDetailGeneration] = useState(0);
  const mounted = useRef(false),
    currentLocation = useRef(location.key),
    currentFilters = useRef(filterKey);
  currentLocation.current = location.key;
  currentFilters.current = filterKey;
  const exportAbort = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null),
    focusPage = useRef(false);
  const toast = useToast();
  const own = useAttendanceData('/api/attendance/me', (value) =>
    checkedAttendanceContext(value, user.id),
  );
  const staff = useAttendanceData(admin ? '/api/attendance/staff' : null, checkedAttendanceStaff);
  const rangeError = attendancePeriod(from, to);
  const reportQuery = new URLSearchParams({ from, to, page: String(page), pageSize: '25' });
  if (userId) reportQuery.set('userId', userId);
  if (status !== 'all') reportQuery.set('status', status);
  const report = useAttendanceData(rangeError ? null : `/api/attendance?${reportQuery}`, (value) =>
    checkedAttendanceReport(value, filters, page),
  );
  const currentReport = useRef({ usable: false, revision: '' });
  currentReport.current = {
    usable: !report.loading && !report.error && !rangeError && !!report.data,
    revision: report.data?.revision ?? '',
  };
  const exportingRevision = useRef('');
  const selectedId = params.get('entry');
  const openShift = own.data?.openShift;
  const needsRepair =
    !!openShift &&
    !!own.data &&
    Date.parse(own.data.serverNow) - Date.parse(openShift.startedAt) > 36 * 3_600_000;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      exportAbort.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    // Apply/Reset and server page clamping must not erase newer form input.
    // History navigation restores its filters before another input event.
    if (navigationType !== 'POP' && ownFilterNavigations.current.delete(params.toString())) return;
    ownFilterNavigations.current.clear();
    setForm({ from, to, staff: userId ?? '', status });
    setFormError('');
  }, [location.key]);
  useEffect(() => {
    setExportError('');
    exportAbort.current?.abort();
    setExporting(false);
  }, [location.key]);
  useEffect(() => {
    if (
      exportAbort.current &&
      (!currentReport.current.usable ||
        currentReport.current.revision !== exportingRevision.current)
    ) {
      exportAbort.current.abort();
      setExporting(false);
    }
  }, [report.loading, report.error, report.data?.revision, rangeError]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) {
        void own.reload();
        void report.reload();
      }
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [own.reload, report.reload]);
  useEffect(() => {
    if (!report.loading && !report.error && report.data) {
      if (report.data.page !== page)
        setParams(
          (old) => {
            const next = new URLSearchParams(old);
            if (report.data!.page === 1) next.delete('page');
            else next.set('page', String(report.data!.page));
            ownFilterNavigations.current.add(next.toString());
            return next;
          },
          { replace: true },
        );
      if (focusPage.current) {
        focusPage.current = false;
        heading.current?.focus({ preventScroll: true });
      }
    }
  }, [report.loading, report.error, report.data, page, setParams]);
  function updateQuery(
    values: Record<string, string | null>,
    replace = false,
    preserveFilterDraft = false,
  ) {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        for (const [key, value] of Object.entries(values)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (preserveFilterDraft) ownFilterNavigations.current.add(next.toString());
        return next;
      },
      { replace },
    );
  }
  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const error = attendancePeriod(form.from, form.to);
    setFormError(error);
    if (!error)
      updateQuery(
        {
          from: form.from,
          to: form.to,
          staff: view === 'team' ? form.staff || null : null,
          status: form.status === 'all' ? null : form.status,
          page: null,
        },
        false,
        true,
      );
  }
  function start(operation: AttendanceOperation, source: Draft['source'] = null) {
    if (draft) {
      setEditorOpen(true);
      return;
    }
    const target = source
      ? 'shift' in source
        ? source.shift.userId
        : source.staff.id
      : view === 'team'
        ? (userId ?? '')
        : user.id;
    setDraft(makeDraft(operation, source, target));
    setEditorOpen(true);
    if (selectedId) updateQuery({ entry: null }, true);
  }
  async function saved(shift: AttendanceShift) {
    const savedLocation = currentLocation.current;
    setDraft(null);
    setEditorOpen(false);
    setDetailGeneration((v) => v + 1);
    toast('Attendance recorded.');
    await Promise.all([own.reload(), report.reload()]);
    if (mounted.current && currentLocation.current === savedLocation)
      updateQuery({ entry: shift.id }, true);
  }
  async function exportCsv() {
    if (!report.data || report.loading || report.error || rangeError || exporting) return;
    const source = report.data,
      sourceKey = filterKey,
      locationKey = location.key;
    const controller = new AbortController();
    exportAbort.current = controller;
    exportingRevision.current = source.revision;
    setExporting(true);
    setExportError('');
    const query = new URLSearchParams({ from, to, expectedRevision: source.revision });
    if (userId) query.set('userId', userId);
    if (status !== 'all') query.set('status', status);
    try {
      const response = await fetch(`/api/attendance/export.csv?${query}`, {
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new Error(
          value?.error || 'The export could not be confirmed. Refresh this report and try again.',
        );
      }
      if (
        !/^text\/csv(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
        !/^attachment\s*;/i.test(response.headers.get('content-disposition') ?? '') ||
        response.headers.get('X-Attendance-Revision') !== source.revision
      )
        throw new Error(
          'The response did not confirm the requested attendance CSV. Refresh the report and try again.',
        );
      const blob = await response.blob();
      if (
        !mounted.current ||
        controller.signal.aborted ||
        sourceKey !== currentFilters.current ||
        locationKey !== currentLocation.current ||
        !currentReport.current.usable ||
        currentReport.current.revision !== source.revision
      )
        return;
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `attendance-${from}-to-${to}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        sourceKey === currentFilters.current &&
        locationKey === currentLocation.current
      )
        setExportError(attendanceFailure(problem));
    } finally {
      if (mounted.current && exportAbort.current === controller) {
        setExporting(false);
        exportAbort.current = null;
      }
    }
  }
  const unavailable = report.loading || !!report.error || !!rangeError || !report.data;
  return (
    <div className="attendance-workspace">
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Staff attendance"
        description="Record attendance with a clear history of every correction."
        actions={
          <>
            <button
              className="button button-secondary"
              onClick={() => {
                void own.reload();
                void report.reload();
                if (admin) void staff.reload();
              }}
            >
              <RefreshCw size={16} />
              Refresh attendance
            </button>
            {admin && (
              <button
                className="button button-primary"
                disabled={!!draft}
                onClick={() => start('manual-entry')}
              >
                <Plus size={16} />
                Record missed attendance
              </button>
            )}
          </>
        }
      />
      <Card className="attendance-clock-card">
        <section aria-label="My clock status">
          <div className="attendance-clock-heading">
            <Clock3 size={24} />
            <div>
              <h2>My attendance</h2>
              <p>
                {user.name} · {user.role}
              </p>
            </div>
          </div>
          {own.loading ? (
            <Loading />
          ) : own.error ? (
            <ErrorState message={own.error} retry={own.reload} />
          ) : (
            own.data && (
              <>
                <div className="attendance-current">
                  <Badge tone={openShift ? 'green' : 'neutral'}>
                    {openShift ? 'Clocked in' : 'Not clocked in'}
                  </Badge>
                  <p>
                    {openShift ? (
                      <>Since {attendanceStamp(openShift.startedAt)} IST</>
                    ) : (
                      'No open attendance entry is recorded.'
                    )}
                  </p>
                </div>
                {needsRepair && (
                  <div className="notice notice-warning">
                    This open entry is older than 36 hours. An administrator must correct or void it
                    before you can clock out or start another entry.
                  </div>
                )}
                <div className="attendance-clock-actions">
                  <button
                    className="button button-primary"
                    disabled={!!draft || needsRepair}
                    onClick={() => start(openShift ? 'clock-out' : 'clock-in', own.data)}
                  >
                    {openShift ? <LogOut size={17} /> : <LogIn size={17} />}{' '}
                    {openShift ? 'Clock out' : 'Clock in'}
                  </button>
                  {openShift && (
                    <button
                      className="button button-secondary"
                      onClick={() => updateQuery({ entry: openShift.id })}
                    >
                      View open entry
                    </button>
                  )}
                </div>
                <p className="muted small">
                  Times are recorded by the clinic server. Last checked{' '}
                  {attendanceStamp(own.data.serverNow)} IST.
                </p>
              </>
            )
          )}
        </section>
        <div className="attendance-explanation">
          <h3>A record of attendance</h3>
          <p>
            Clock entries record submitted times. They do not verify physical presence or calculate
            absence, lateness, overtime or payroll.
          </p>
          <p>
            Administrator corrections remain visible to the staff member with the original entry and
            reason.
          </p>
        </div>
      </Card>
      {draft && !editorOpen && (
        <div className="notice attendance-pending">
          <div>
            <strong>An attendance update is unfinished.</strong>
            <p>Your draft and any submitted request are retained while this page stays open.</p>
          </div>
          <button className="button button-secondary" onClick={() => setEditorOpen(true)}>
            Resume pending attendance update
          </button>
        </div>
      )}
      {admin && (
        <div className="attendance-views" role="group" aria-label="Attendance views">
          {[
            ['mine', 'My attendance'],
            ['team', 'Team timesheet'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={`button ${view === value ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={view === value}
              onClick={() => {
                setForm((current) => ({ ...current, staff: value === 'mine' ? user.id : '' }));
                updateQuery(
                  { view: value === 'team' ? 'team' : null, staff: null, page: null },
                  false,
                  true,
                );
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <Card className="attendance-filters">
        <form onSubmit={applyFilters}>
          <Field label="From date">
            <input
              type="date"
              required
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <Field label="To date">
            <input
              type="date"
              required
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </Field>
          {admin && view === 'team' && (
            <Field label="Staff member">
              <select
                value={form.staff}
                onChange={(e) => setForm({ ...form, staff: e.target.value })}
              >
                <option value="">All staff</option>
                {staff.data?.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} · {person.role}
                    {person.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Entry status">
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as AttendanceFilters['status'] })
              }
            >
              <option value="all">All entries</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="voided">Voided</option>
            </select>
          </Field>
          <div className="attendance-filter-actions">
            <button className="button button-primary">Apply filters</button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setForm({
                  from: `${today().slice(0, 7)}-01`,
                  to: today(),
                  staff: view === 'mine' ? user.id : '',
                  status: 'all',
                });
                setFormError('');
                updateQuery(
                  { from: null, to: null, staff: null, status: null, page: null },
                  false,
                  true,
                );
              }}
            >
              Reset filters
            </button>
          </div>
        </form>
        {(formError || rangeError) && (
          <p className="form-error" role="alert">
            {formError || rangeError}
          </p>
        )}
        {admin && staff.error && <ErrorState message={staff.error} retry={staff.reload} />}
        <p className="muted small attendance-period-note">
          Periods include entries whose current start date falls within these dates in India
          Standard Time. A completed overnight shift contributes its full duration to its start
          date. Open and voided entries contribute no recorded time.
        </p>
      </Card>
      <div className="attendance-metrics" aria-label="Attendance report totals">
        {[
          [
            'Recorded time',
            unavailable ? 'Unavailable' : attendanceDuration(report.data!.totals.recordedSeconds),
          ],
          ['Closed entries', unavailable ? '—' : String(report.data!.totals.closedShiftCount)],
          ['Open entries', unavailable ? '—' : String(report.data!.totals.openShiftCount)],
          ['Voided entries', unavailable ? '—' : String(report.data!.totals.voidedShiftCount)],
        ].map(([label, value]) => (
          <Card key={label}>
            <span>{label}</span>
            <strong>{report.loading ? 'Loading…' : value}</strong>
          </Card>
        ))}
      </div>
      <Card>
        <div className="attendance-report-heading">
          <div>
            <h2 tabIndex={-1} ref={heading}>
              {view === 'team' ? 'Team timesheet' : 'My attendance history'}
            </h2>
            <p className="muted small">
              {unavailable
                ? report.loading
                  ? 'Loading attendance…'
                  : 'Attendance count unavailable'
                : `${report.data!.total} ${report.data!.total === 1 ? 'entry' : 'entries'} · Totals cover the entire filtered report`}
            </p>
          </div>
          {admin && (
            <button
              className="button button-secondary"
              disabled={unavailable || exporting}
              onClick={exportCsv}
            >
              <Download size={16} />
              {exporting ? 'Preparing CSV…' : 'Export attendance CSV'}
            </button>
          )}
        </div>
        {exportError && (
          <ErrorState
            message={exportError}
            retry={() => {
              setExportError('');
              void report.reload();
            }}
          />
        )}
        {rangeError ? (
          <ErrorState message={rangeError} />
        ) : report.loading ? (
          <Loading />
        ) : report.error ? (
          <ErrorState message={report.error} retry={report.reload} />
        ) : report.data && !report.data.items.length ? (
          <EmptyState
            title="No attendance entries match"
            description="Try another period, staff member or entry status. Missing records do not imply absence."
          />
        ) : (
          report.data && (
            <div
              className="table-wrap attendance-table-region"
              role="region"
              aria-label="Attendance entries; scroll horizontally for all columns"
              tabIndex={0}
            >
              <table className="data-table attendance-report-table">
                <thead>
                  <tr>
                    <th scope="col">Staff member</th>
                    <th scope="col">Start · IST</th>
                    <th scope="col">End · IST</th>
                    <th scope="col">Recorded time</th>
                    <th scope="col">Status</th>
                    <th scope="col">History</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((shift) => (
                    <tr key={shift.id}>
                      <td>
                        <strong>{shift.staffName}</strong>
                        <span className="attendance-table-sub">
                          {shift.staffRole} ·{' '}
                          {shift.source === 'clock' ? 'Self clocking' : 'Manual entry'}
                        </span>
                      </td>
                      <td>{attendanceStamp(shift.startedAt)}</td>
                      <td>
                        {shift.endedAt ? attendanceStamp(shift.endedAt) : 'No clock-out recorded'}
                      </td>
                      <td>
                        {shift.recordedSeconds === null
                          ? '—'
                          : attendanceDuration(shift.recordedSeconds)}
                      </td>
                      <td>
                        <ShiftStatus shift={shift} />
                      </td>
                      <td>
                        <button
                          className="button button-secondary button-small"
                          onClick={() => updateQuery({ entry: shift.id })}
                        >
                          <History size={14} />
                          View attendance entry
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {!unavailable && report.data && (
          <Pagination
            {...report.data}
            label="Attendance pagination"
            onPageChange={(value) => {
              focusPage.current = true;
              updateQuery({ page: value === 1 ? null : String(value) });
            }}
          />
        )}
      </Card>
      {selectedId && !editorOpen && (
        <AttendanceDetailModal
          key={`${selectedId}:${detailGeneration}`}
          id={selectedId}
          admin={admin}
          pending={!!draft}
          onClose={() => updateQuery({ entry: null }, true)}
          onStart={start}
        />
      )}
      {editorOpen && draft && (
        <AttendanceEditor
          draft={draft}
          setDraft={setDraft}
          actorId={user.id}
          staff={staff.data ?? []}
          staffError={staff.error}
          onClose={() => setEditorOpen(false)}
          onDiscard={() => {
            setDraft(null);
            setEditorOpen(false);
          }}
          onSaved={saved}
        />
      )}
    </div>
  );
}

function AttendanceDetailModal({
  id,
  admin,
  pending,
  onClose,
  onStart,
}: {
  id: string;
  admin: boolean;
  pending: boolean;
  onClose: () => void;
  onStart: (operation: AttendanceOperation, source: AttendanceDetail) => void;
}) {
  const record = useAttendanceData(`/api/attendance/shifts/${encodeURIComponent(id)}`, (value) =>
    checkedAttendanceDetail(value, id),
  );
  return (
    <Modal title="Attendance entry" onClose={onClose}>
      <div className="stack">
        {record.loading ? (
          <Loading />
        ) : record.error ? (
          <ErrorState message={record.error} retry={record.reload} />
        ) : (
          record.data && (
            <>
              <div className="attendance-entry-heading">
                <div>
                  <h3>{record.data.shift.staffName}</h3>
                  <p>{record.data.shift.staffRole}</p>
                </div>
                <ShiftStatus shift={record.data.shift} />
              </div>
              <StateSummary shift={record.data.shift} />
              {admin && record.data.shift.status !== 'voided' && (
                <div className="attendance-detail-actions">
                  <button
                    className="button button-secondary"
                    disabled={pending}
                    onClick={() => onStart('correction', record.data!)}
                  >
                    <Pencil size={15} />
                    Correct entry
                  </button>
                  <button
                    className="button button-danger"
                    disabled={pending}
                    onClick={() => onStart('void', record.data!)}
                  >
                    Void mistaken entry
                  </button>
                </div>
              )}
              <HistoryView detail={record.data} />
            </>
          )
        )}
      </div>
    </Modal>
  );
}

function AttendanceEditor({
  draft,
  setDraft,
  actorId,
  staff,
  staffError,
  onClose,
  onDiscard,
  onSaved,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  actorId: string;
  staff: AttendanceStaff[];
  staffError: string;
  onClose: () => void;
  onDiscard: () => void;
  onSaved: (shift: AttendanceShift) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false),
    location = useLocation(),
    locationKey = useRef(location.key);
  locationKey.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const manual = draft.operation === 'manual-entry',
    timed = manual || draft.operation === 'correction';
  const context = useAttendanceData(
    manual && draft.userId && !draft.source
      ? `/api/attendance/staff/${encodeURIComponent(draft.userId)}/context`
      : null,
    (value) => checkedAttendanceContext(value, draft.userId),
  );
  useEffect(() => {
    if (manual && !draft.source && context.data && context.data.staff.id === draft.userId)
      setDraft({ ...draft, source: context.data });
  }, [manual, draft, context.data, setDraft]);
  const locked = busy || refreshing || draft.phase !== 'editing';
  const change = (values: Partial<Draft>) => setDraft({ ...draft, ...values, error: '' });
  const shift = sourceShift(draft.source);
  const canProceed =
    !!draft.source &&
    (draft.operation === 'clock-in'
      ? !shift
      : draft.operation === 'clock-out'
        ? shift?.id === draft.shiftId &&
          shift.status === 'open' &&
          'serverNow' in draft.source &&
          Date.parse(draft.source.serverNow) - Date.parse(shift.startedAt) <= 36 * 3_600_000
        : draft.operation === 'correction' || draft.operation === 'void'
          ? shift?.status !== 'voided'
          : true);
  function buildAttempt(): AttendanceAttempt {
    if (!draft.source || !canProceed)
      throw new Error(
        'This action is no longer available for the current attendance record. Review the latest entry.',
      );
    const expectedRevision =
      'shift' in draft.source ? draft.source.shift.revision : draft.source.revision;
    const body: Record<string, unknown> = { requestId: draft.requestId, expectedRevision };
    let path = '/api/attendance/clock-in';
    if (draft.operation === 'clock-out') path = `/api/attendance/shifts/${draft.shiftId}/clock-out`;
    if (timed) {
      const startedAt = attendanceInput(draft.startDate, draft.startTime, shift?.startedAt),
        endedAt = attendanceInput(draft.endDate, draft.endTime, shift?.endedAt);
      if (endedAt < startedAt) throw new Error('The end must be on or after the start.');
      if (Date.parse(endedAt) - Date.parse(startedAt) > 36 * 3_600_000)
        throw new Error('An attendance entry may span no more than 36 hours.');
      if (Date.parse(endedAt) > Date.now())
        throw new Error('Attendance times cannot be in the future.');
      Object.assign(body, { startedAt, endedAt });
      if (manual) {
        path = '/api/attendance/shifts';
        body.userId = draft.userId;
      } else path = `/api/attendance/shifts/${draft.shiftId}/corrections`;
    }
    if (timed || draft.operation === 'void') {
      const reason = draft.reason.trim();
      if (!reason || reason.length > 1000)
        throw new Error('Enter a reason of 1 to 1,000 characters.');
      body.reason = reason;
    }
    if (draft.operation === 'void') {
      if (!draft.confirmed)
        throw new Error('Confirm that this attendance entry was recorded by mistake.');
      path = `/api/attendance/shifts/${draft.shiftId}/void`;
    }
    return {
      path,
      body,
      operation: draft.operation,
      userId: draft.userId,
      shiftId: draft.shiftId,
      before:
        manual || draft.operation === 'clock-in' ? null : shift ? attendanceState(shift) : null,
      actorId,
    };
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || refreshing || draft.phase === 'conflict') return;
    let attempt: AttendanceAttempt;
    try {
      attempt = draft.attempt ?? buildAttempt();
    } catch (problem) {
      change({ error: attendanceFailure(problem) });
      return;
    }
    const submittingLocation = location.key;
    setBusy(true);
    setDraft({ ...draft, attempt, error: '' });
    try {
      const response = checkedAttendanceMutation(
        await api<unknown>(attempt.path, { method: 'POST', body: attempt.body }),
        attempt,
      );
      if (!mounted.current) return;
      if (locationKey.current !== submittingLocation) {
        setDraft({
          ...draft,
          attempt,
          phase: 'uncertain',
          error:
            'The page changed before confirmation was displayed. Retry the same request to confirm its recorded outcome.',
        });
        return;
      }
      await onSaved(response.shift);
    } catch (problem) {
      if (!mounted.current) return;
      const requestCollision =
        problem instanceof ApiError &&
        problem.status === 409 &&
        problem.message.includes('request ID was already used');
      // A later denial cannot establish whether an earlier uncertain write saved.
      const known =
        draft.phase !== 'uncertain' &&
        !requestCollision &&
        problem instanceof ApiError &&
        [400, 401, 403, 404, 409].includes(problem.status);
      setDraft({
        ...draft,
        attempt: known ? null : attempt,
        phase:
          known && problem instanceof ApiError && problem.status === 409
            ? 'conflict'
            : known
              ? 'editing'
              : 'uncertain',
        reviewed: null,
        error: attendanceFailure(problem),
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function refreshLatest() {
    if (refreshing || busy) return;
    setRefreshing(true);
    try {
      const source =
        draft.operation === 'correction' || draft.operation === 'void'
          ? checkedAttendanceDetail(
              await api<unknown>(`/api/attendance/shifts/${draft.shiftId}`),
              draft.shiftId!,
            )
          : checkedAttendanceContext(
              await api<unknown>(
                manual
                  ? `/api/attendance/staff/${encodeURIComponent(draft.userId)}/context`
                  : '/api/attendance/me',
              ),
              draft.userId,
            );
      if (mounted.current) setDraft({ ...draft, reviewed: source, error: '' });
    } catch (problem) {
      if (mounted.current) setDraft({ ...draft, error: attendanceFailure(problem) });
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  const saveLabel =
    draft.operation === 'clock-in'
      ? 'Confirm clock in'
      : draft.operation === 'clock-out'
        ? 'Confirm clock out'
        : manual
          ? 'Save missed attendance'
          : draft.operation === 'correction'
            ? 'Save correction'
            : 'Void entry';
  return (
    <Modal
      title={operationLabels[draft.operation]}
      onClose={() => {
        if (!busy && !refreshing) onClose();
      }}
    >
      <form className="stack attendance-editor" onSubmit={submit}>
        {draft.error && <ErrorState message={draft.error} />}
        {draft.phase === 'uncertain' && (
          <div className="notice notice-warning">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              The exact request and its values are retained. Retry the same request before making
              another attendance update.
            </p>
          </div>
        )}
        {draft.source && (
          <section className="attendance-source" aria-label="Attendance source">
            <strong>
              {'shift' in draft.source ? draft.source.shift.staffName : draft.source.staff.name}
            </strong>
            {shift ? <StateSummary shift={shift} /> : <p>No open attendance entry is recorded.</p>}
          </section>
        )}
        {manual && (
          <Field label="Attendance staff">
            <select
              required
              disabled={locked || !!draft.attempt}
              value={draft.userId}
              onChange={(event) => change({ userId: event.target.value, source: null })}
            >
              <option value="">Choose a staff member</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} · {person.role}
                  {person.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
        )}
        {manual && staffError && <ErrorState message={staffError} />}
        {context.loading && <Loading />}
        {context.error && <ErrorState message={context.error} retry={context.reload} />}
        {timed && (
          <>
            <p className="muted small">
              Enter the complete interval in India Standard Time (Asia/Kolkata). The end may be on
              the following date; maximum duration is 36 hours.
            </p>
            <div className="form-grid">
              <Field label="Start date (IST)">
                <input
                  type="date"
                  required
                  max={today()}
                  disabled={locked}
                  value={draft.startDate}
                  onChange={(e) => change({ startDate: e.target.value })}
                />
              </Field>
              <Field label="Start time (IST)">
                <input
                  type="time"
                  step="1"
                  required
                  disabled={locked}
                  value={draft.startTime}
                  onChange={(e) => change({ startTime: e.target.value })}
                />
              </Field>
              <Field label="End date (IST)">
                <input
                  type="date"
                  required
                  max={today()}
                  disabled={locked}
                  value={draft.endDate}
                  onChange={(e) => change({ endDate: e.target.value })}
                />
              </Field>
              <Field label="End time (IST)">
                <input
                  type="time"
                  step="1"
                  required
                  disabled={locked}
                  value={draft.endTime}
                  onChange={(e) => change({ endTime: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {(timed || draft.operation === 'void') && (
          <Field
            label="Reason"
            hint="This reason is visible to the staff member in their attendance history."
          >
            <textarea
              required
              maxLength={1000}
              rows={3}
              disabled={locked}
              value={draft.reason}
              onChange={(e) => change({ reason: e.target.value })}
            />
          </Field>
        )}
        {!timed && draft.operation !== 'void' && (
          <p>
            The clinic server records the {draft.operation === 'clock-in' ? 'start' : 'end'} time
            when you confirm. Your entry will retain the original timestamps and any later
            administrator corrections.
          </p>
        )}
        {draft.operation === 'void' && (
          <>
            <p>
              Voiding removes this entry from recorded-time totals and releases an open interval.
              The original entry and history are retained.
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                required
                checked={draft.confirmed}
                disabled={locked}
                onChange={(e) => change({ confirmed: e.target.checked })}
              />
              I confirm this attendance entry was recorded by mistake
            </label>
          </>
        )}
        {draft.phase === 'conflict' && (
          <section className="attendance-conflict">
            <h3>Review the latest attendance</h3>
            <p>
              The record or available interval changed. Your draft is preserved. Refresh, review the
              current state, then explicitly keep your draft before saving a new request.
            </p>
            <button
              className="button button-secondary"
              type="button"
              disabled={refreshing}
              onClick={refreshLatest}
            >
              {refreshing ? 'Refreshing…' : 'Refresh latest attendance'}
            </button>
            {draft.reviewed && (
              <>
                <div className="attendance-reviewed-context">
                  <ContextSummary source={draft.reviewed} />
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={refreshing}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      source: draft.reviewed,
                      reviewed: null,
                      attempt: null,
                      requestId: crypto.randomUUID(),
                      confirmed: false,
                      phase: 'editing',
                      error: '',
                    })
                  }
                >
                  I reviewed the latest attendance; keep my draft
                </button>
              </>
            )}
          </section>
        )}
        {draft.source && !canProceed && draft.phase === 'editing' && (
          <div className="notice notice-warning">
            This action is not available for the latest record. An existing open entry must be
            closed or repaired before another clock-in; voided entries cannot be changed. Entries
            older than 36 hours need administrator correction or void.
          </div>
        )}
        <div className="modal-actions attendance-editor-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || refreshing}
            onClick={onClose}
          >
            Close for now
          </button>
          {draft.phase !== 'uncertain' && (
            <button
              type="button"
              className="button button-ghost"
              disabled={busy || refreshing}
              onClick={onDiscard}
            >
              Discard draft
            </button>
          )}
          <button
            className={`button ${draft.operation === 'void' ? 'button-danger' : 'button-primary'}`}
            disabled={
              busy ||
              refreshing ||
              draft.phase === 'conflict' ||
              (draft.phase !== 'uncertain' && !canProceed)
            }
          >
            {busy ? 'Saving…' : draft.phase === 'uncertain' ? 'Retry same request' : saveLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
