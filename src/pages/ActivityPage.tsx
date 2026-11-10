import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  CalendarDays,
  Check,
  ClipboardList,
  FileText,
  HeartHandshake,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import type { ActivityFeed, ActivityItem, ActivityKind } from '../../shared/activity';
import { api, formatDate, useSession, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import './activity.css';

const icons = {
  appointment: CalendarDays,
  'care-plan': ClipboardList,
  message: MessageSquare,
  'check-in': HeartHandshake,
  investigation: FileText,
  procedure: ClipboardList,
  'follow-up': HeartHandshake,
};
const labels: Record<ActivityKind, string> = {
  appointment: 'Appointment',
  'care-plan': 'Care plan',
  message: 'Message',
  'check-in': 'Patient check-in',
  investigation: 'Investigation',
  procedure: 'Procedure',
  'follow-up': 'Follow-up',
};
const changed = () => window.dispatchEvent(new Event('derma:activity-changed'));

export function ActivityPage() {
  const { session } = useSession();
  const toast = useToast();
  const [unread, setUnread] = useState(false);
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const request = useRef(0);
  const mutating = useRef(false);
  const pendingRefresh = useRef(false);
  const reload = useCallback(
    async (cursor?: string) => {
      if (mutating.current) {
        pendingRefresh.current = true;
        return;
      }
      const serial = ++request.current;
      setLoading(true);
      setError('');
      try {
        const result = await api<ActivityFeed>(
          `/api/activity?unread=${unread}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        if (serial !== request.current) return;
        setFeed((previous) => ({
          ...result,
          items:
            cursor && previous
              ? [
                  ...previous.items,
                  ...result.items.filter(
                    (item) => !previous.items.some((old) => old.id === item.id),
                  ),
                ]
              : result.items,
        }));
      } catch (error) {
        if (serial === request.current) setError((error as Error).message);
      } finally {
        if (serial === request.current) setLoading(false);
      }
    },
    [unread],
  );
  useEffect(() => {
    setFeed(null);
    void reload();
    return () => {
      request.current++;
    };
  }, [reload]);
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [reload]);
  async function read(item: ActivityItem) {
    if (mutating.current || loading) return;
    mutating.current = true;
    ++request.current;
    setBusy(item.id);
    try {
      const updated = await api<ActivityItem>(`/api/activity/${item.id}/read`, { method: 'POST' });
      setFeed((current) =>
        current
          ? {
              ...current,
              unreadCount: Math.max(
                0,
                current.unreadCount -
                  (current.items.some((row) => row.id === item.id && !row.readAt) ? 1 : 0),
              ),
              items: unread
                ? current.items.filter((row) => row.id !== item.id)
                : current.items.map((row) => (row.id === item.id ? updated : row)),
            }
          : current,
      );
      changed();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      mutating.current = false;
      setBusy('');
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void reload();
      } else if (unread && feed?.items.length === 1 && feed.nextCursor)
        void reload(feed.nextCursor);
    }
  }
  async function readAll() {
    if (!feed?.items.length || mutating.current || loading) return;
    mutating.current = true;
    ++request.current;
    setBusy('all');
    try {
      await api('/api/activity/read-all', {
        method: 'POST',
        body: { throughId: feed.items[0].id },
      });
      changed();
      toast('Current updates marked read.');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      mutating.current = false;
      pendingRefresh.current = false;
      setBusy('');
      await reload();
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="KEEP THE NEXT STEP IN SIGHT"
        title="Activity"
        description="Updates from your care workspace, gathered in one place."
        actions={
          <button
            className="button button-secondary"
            disabled={loading || !!busy}
            onClick={() => {
              void reload();
              changed();
            }}
          >
            <RefreshCw size={15} />
            Refresh updates
          </button>
        }
      />
      <div className="notice">
        <Bell size={19} />
        <span>
          Updates appear here when you open or refresh the app. Email, SMS, WhatsApp, and push
          delivery are not connected.
          {session.user?.role !== 'patient' &&
            ' Marking an update read does not record a clinical review.'}
        </span>
      </div>
      <Card>
        <div className="activity-toolbar">
          <div className="segmented" aria-label="Activity filter">
            <button
              disabled={!!busy}
              className={!unread ? 'active' : ''}
              onClick={() => setUnread(false)}
            >
              All updates
            </button>
            <button
              disabled={!!busy}
              className={unread ? 'active' : ''}
              onClick={() => setUnread(true)}
            >
              Unread {feed ? `(${feed.unreadCount})` : ''}
            </button>
          </div>
          <button
            className="button button-ghost button-small"
            disabled={!feed?.unreadCount || !feed.items.length || !!busy || loading}
            onClick={readAll}
          >
            <Check size={15} />
            {busy === 'all' ? 'Marking…' : 'Mark all read'}
          </button>
        </div>
        {error && <ErrorState message={error} retry={() => void reload()} />}
        {error && !feed ? null : loading && !feed ? (
          <Loading />
        ) : !feed?.items.length ? (
          <EmptyState
            title={
              feed?.unreadCount && unread
                ? 'More unread updates'
                : unread
                  ? 'You’re caught up'
                  : 'No updates yet'
            }
            description={
              feed?.unreadCount && unread
                ? 'Load earlier updates to continue through your inbox.'
                : unread
                  ? 'There are no unread updates in this inbox.'
                  : 'New messages and care updates will appear here. Previous care records remain available in your workspace.'
            }
          />
        ) : (
          <div className="activity-list">
            {feed.items.map((item) => {
              const Icon = icons[item.kind] || Bell;
              return (
                <article
                  className={`activity-item ${item.readAt ? '' : 'activity-unread'}`}
                  key={item.id}
                >
                  <span className="activity-kind-icon">
                    <Icon size={20} />
                  </span>
                  <div className="activity-copy">
                    <div className="activity-item-meta">
                      <span>{labels[item.kind]}</span>
                      <time dateTime={item.createdAt}>
                        {formatDate(item.createdAt)} ·{' '}
                        {new Date(item.createdAt).toLocaleTimeString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        IST
                      </time>
                    </div>
                    <h2>
                      <Link to={item.href}>{item.title}</Link>
                    </h2>
                    <p>{item.detail}</p>
                    <div className="activity-item-actions">
                      <Link className="text-link" to={item.href}>
                        Open update →
                      </Link>
                      {item.readAt ? (
                        <Badge tone="neutral">Read</Badge>
                      ) : (
                        <>
                          <Badge tone="green">Unread</Badge>
                          <button
                            className="button button-ghost button-small"
                            disabled={!!busy || loading}
                            onClick={() => read(item)}
                          >
                            {busy === item.id ? 'Marking…' : 'Mark read'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {feed?.nextCursor && (
          <div className="activity-load-more">
            <button
              className="button button-secondary"
              disabled={loading || !!busy}
              onClick={() => void reload(feed.nextCursor!)}
            >
              {loading ? 'Loading…' : 'Load earlier updates'}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
