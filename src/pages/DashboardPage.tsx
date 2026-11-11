import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock3,
  FileCheck2,
  HeartHandshake,
  Plus,
  Stethoscope,
  Users,
} from 'lucide-react';
import { Avatar, Badge, Card, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import { formatDate, money, useResource, useSession } from '../lib';
import type { Dashboard } from '../../shared/types';
import type { InvestigationWorkItem } from '../../shared/investigation-worklist';
import './investigation-overview.css';

function InvestigationOverview() {
  const { session } = useSession();
  const scope = session.user?.role === 'doctor' ? 'mine' : 'all';
  const resource = useResource<InvestigationWorkItem[]>(
    `/api/investigation-worklist?scope=${scope}`,
  );
  useEffect(() => {
    const refresh = () => {
      void resource.reload();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [resource.reload]);
  const rows = Array.isArray(resource.data) ? resource.data : null;
  const unavailable =
    rows?.filter((entry) => entry.status !== 'cancelled' && !entry.ownerAvailable).length ?? 0;
  return (
    <Card className="investigation-overview">
      <div className="section-heading">
        <div>
          <h2>
            <FileCheck2 size={20} /> Investigation reviews
          </h2>
          <p className="muted">
            {scope === 'mine' ? 'Your assigned investigations' : 'All clinic investigations'} ·
            Latest submitted results
          </p>
        </div>
        <Link className="text-link" to="/clinic/investigations">
          Open review queue <ArrowRight size={15} />
        </Link>
      </div>
      {resource.loading ? (
        <p role="status">Loading investigation review counts…</p>
      ) : resource.error || !rows ? (
        <ErrorState
          message={resource.error || 'Investigation counts are unavailable.'}
          retry={resource.reload}
        />
      ) : (
        <>
          <div className="investigation-overview-counts">
            {[
              {
                label: 'Results awaiting review',
                value: rows.filter((entry) => entry.needsReview).length,
              },
              {
                label: 'Latest reviews not shared',
                value: rows.filter((entry) => entry.awaitingPublication).length,
              },
              {
                label: 'Missing results past requested date',
                value: rows.filter((entry) => entry.pastRequestedDate).length,
              },
            ].map((metric) => (
              <div role="group" aria-label={metric.label} key={metric.label}>
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
              </div>
            ))}
          </div>
          {unavailable > 0 && (
            <p className="notice">
              {unavailable} {unavailable === 1 ? 'investigation has' : 'investigations have'} no
              active account linked to the responsible clinician. Open the queue to review
              responsibility.
            </p>
          )}
          <p className="muted small">
            Requested dates track missing results. They do not indicate clinical urgency or a
            deadline for reviewing a result.
          </p>
        </>
      )}
    </Card>
  );
}
export function DashboardPage() {
  const { data, loading, error, reload } = useResource<Dashboard>('/api/dashboard');
  const { session } = useSession();
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return null;
  const { stats } = data;
  const firstName = session.user?.name.replace(/^Dr\.?\s+/i, '').split(' ')[0];
  const clinical = session.user?.role !== 'receptionist';
  const max = Math.max(1, ...data.weekly.map((x) => x.count));
  const confirmed = data.appointments.filter((a) => !['cancelled', 'no-show'].includes(a.status));
  const finished = data.appointments.filter((a) => a.status === 'completed').length;
  return (
    <>
      <PageHeader
        eyebrow="YOUR CLINIC, AT A GLANCE"
        title={`A good day for better care, ${firstName}.`}
        description="Your appointments, patients, and the little things that make a difference."
        actions={
          <>
            <span className="date-pill">
              <CalendarDays size={16} />
              {formatDate(data.date)}
            </span>
            <Link className="button button-primary" to="/clinic/appointments?new=1">
              <Plus size={17} />
              New appointment
            </Link>
          </>
        }
      />
      <div className="overview-banner">
        <div>
          <span className="banner-kicker">
            <span className="live-dot" /> TODAY’S FOCUS
          </span>
          <h2>Every visit is a step forward.</h2>
          <p>
            {stats.appointments
              ? `${stats.appointments} appointments on the schedule. `
              : 'Your schedule is clear. '}
            {stats.followUps
              ? `${stats.followUps} care plans are ready for a follow-up.`
              : 'A little room to give every patient your full attention.'}
          </p>
          <Link to="/clinic/appointments">
            Let’s see your day <ArrowRight size={16} />
          </Link>
        </div>
        <div className="banner-art" aria-hidden="true">
          <div className="banner-ring ring-one" />
          <div className="banner-ring ring-two" />
          <div className="banner-ring ring-three" />
          <div className="banner-flower">✳</div>
          <span className="banner-tag">
            <HeartHandshake size={16} />
            Care, connected.
          </span>
        </div>
      </div>
      <div className="metric-grid">
        {[
          {
            label: 'Today’s appointments',
            value: stats.appointments,
            icon: CalendarDays,
            note: `${confirmed.filter((a) => a.mode === 'in-person').length} in clinic · ${confirmed.filter((a) => a.mode === 'online').length} online`,
            tone: 'green',
          },
          {
            label: 'Checked in',
            value: stats.checkedIn,
            icon: Clock3,
            note: 'Ready for their consultation',
            tone: 'amber',
          },
          {
            label: 'Patients in your care',
            value: stats.patients,
            icon: Users,
            note: 'A growing circle of care',
            tone: 'purple',
          },
          {
            label: 'Follow-ups due',
            value: stats.followUps,
            icon: HeartHandshake,
            note: 'Due today or awaiting review',
            tone: 'blue',
          },
        ].map((m) => (
          <Card key={m.label} className="metric-card">
            <div className="row between">
              <span>{m.label}</span>
              <span className={`metric-icon metric-${m.tone}`}>
                <m.icon size={18} />
              </span>
            </div>
            <strong className="metric-value">{m.value.toString().padStart(2, '0')}</strong>
            <small>{m.note}</small>
          </Card>
        ))}
      </div>
      <div className="dashboard-grid">
        <Card className="schedule-card">
          <div className="section-heading">
            <div>
              <h2>
                Today’s appointments{' '}
                <span className="count-bubble">{data.appointments.length}</span>
              </h2>
              <p className="muted">A thoughtful rhythm for your day.</p>
            </div>
            <Link className="text-link" to="/clinic/appointments">
              View schedule <ArrowUpRight size={15} />
            </Link>
          </div>
          {data.appointments.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Time</th>
                    <th>Consultation</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">View</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.appointments.slice(0, 7).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="row">
                          <Avatar name={a.patientName} size="sm" />
                          <div>
                            <Link
                              className="patient-name"
                              to={
                                clinical
                                  ? `/clinic/patients/${a.patientId}`
                                  : '/clinic/appointments'
                              }
                            >
                              {a.patientName}
                            </Link>
                            <small className="table-subtitle">{a.reason}</small>
                          </div>
                        </div>
                      </td>
                      <td className="time-cell">{a.time}</td>
                      <td>
                        <span className="consultation-type">
                          <span className={`type-dot ${a.mode === 'online' ? 'online' : ''}`} />
                          {a.mode === 'online' ? 'Online' : 'In clinic'}
                        </span>
                      </td>
                      <td>
                        <Badge
                          tone={
                            a.status === 'completed'
                              ? 'green'
                              : a.status === 'checked-in'
                                ? 'amber'
                                : a.status === 'in-consultation'
                                  ? 'blue'
                                  : a.status === 'cancelled'
                                    ? 'red'
                                    : 'neutral'
                          }
                        >
                          {a.status.replaceAll('-', ' ')}
                        </Badge>
                      </td>
                      <td>
                        <Link
                          className="icon-button"
                          aria-label={`View appointment for ${a.patientName}`}
                          to="/clinic/appointments"
                        >
                          <ArrowUpRight size={17} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="A little breathing room"
              description="New appointments will appear here."
              action={
                <Link className="button button-secondary" to="/clinic/appointments?new=1">
                  Book an appointment
                </Link>
              }
            />
          )}
          <div className="schedule-summary">
            <span>
              <Check size={15} />
              {finished} visits completed today
            </span>
            <span>
              {money(stats.scheduledValue)} scheduled value <small>· not collections</small>
            </span>
          </div>
        </Card>
        <div className="dashboard-side">
          <Card className="weekly-card">
            <div className="section-heading">
              <div>
                <h2>Your week in care</h2>
                <p className="muted">Appointments over the last 7 days</p>
              </div>
              <span className="metric-icon metric-green">
                <Stethoscope size={18} />
              </span>
            </div>
            <div className="chart-total">
              <strong>{data.weekly.reduce((s, x) => s + x.count, 0)}</strong>
              <span>appointments</span>
            </div>
            <div
              className="bar-chart"
              role="img"
              aria-label={data.weekly.map((d) => `${d.date}: ${d.count} appointments`).join(', ')}
            >
              {data.weekly.map((d) => (
                <div
                  className={`chart-column ${d.date === data.date ? 'chart-today' : ''}`}
                  key={d.date}
                >
                  <span className="bar-value">{d.count}</span>
                  <div className="bar-track">
                    <div style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} />
                  </div>
                  <span>
                    {new Date(`${d.date}T12:00:00+05:30`)
                      .toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' })
                      .slice(0, 2)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <Card className="followup-card">
            <div className="row between">
              <span className="metric-icon metric-green">
                <HeartHandshake size={20} />
              </span>
              <Badge tone="green">CONTINUITY OF CARE</Badge>
            </div>
            <h2>
              Care continues
              <br />
              beyond the clinic.
            </h2>
            <p>
              {stats.followUps
                ? `${stats.followUps} follow-ups could use a little attention. Keep the conversation going.`
                : 'Your follow-up list is up to date. Every check-in helps keep care connected.'}
            </p>
            <Link
              className="text-link"
              to={clinical ? '/clinic/follow-ups' : '/clinic/appointments'}
            >
              {clinical ? 'Review follow-ups' : 'Manage appointments'} <ArrowRight size={17} />
            </Link>
          </Card>
        </div>
      </div>
      {clinical && <InvestigationOverview />}
      <div className="dashboard-bottom">
        <Card>
          <div className="section-heading">
            <div>
              <h2>Recently added patients</h2>
              <p className="muted">New faces in your circle of care.</p>
            </div>
            <Link className="text-link" to="/clinic/patients">
              All patients <ArrowRight size={15} />
            </Link>
          </div>
          <div className="recent-patients">
            {data.recentPatients.slice(0, 4).map((p) => (
              <Link key={p.id} to={clinical ? `/clinic/patients/${p.id}` : '/clinic/patients'}>
                <Avatar name={p.name} />
                <span>
                  <strong>{p.name}</strong>
                  <small>Joined {formatDate(p.createdAt)}</small>
                </span>
                <ArrowUpRight size={16} />
              </Link>
            ))}
            {!data.recentPatients.length && (
              <p className="muted">Your first patient starts the story.</p>
            )}
          </div>
        </Card>
        <div className="small-reminder">
          <span>✦</span>
          <div>
            <h3>The details make the difference.</h3>
            <p>
              A clear note. A timely follow-up. A patient who feels heard. That’s what this space is
              here for.
            </p>
          </div>
          <ArrowDownRight size={26} />
        </div>
      </div>
    </>
  );
}
