import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bell,
  ArrowUpRight,
  CalendarDays,
  Clock3,
  DoorOpen,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  FileText,
  FileCheck2,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  Search,
  BookOpen,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useSession, api, useToast, useResource } from './lib';
import type { ActivityFeed } from '../shared/activity';
import './pages/activity.css';
import { Avatar, Badge, ErrorState, Loading } from './components/ui';
import './operations.css';
const AuthPage = lazy(() =>
  import('./pages/AuthPages').then((module) => ({ default: module.AuthPage })),
);
const AccountsPage = lazy(() =>
  import('./pages/IdentityPages').then((module) => ({ default: module.AccountsPage })),
);
const RecoveryPage = lazy(() =>
  import('./pages/IdentityPages').then((module) => ({ default: module.RecoveryPage })),
);
const SecurityPage = lazy(() =>
  import('./pages/IdentityPages').then((module) => ({ default: module.SecurityPage })),
);
const SchedulingPage = lazy(() =>
  import('./pages/SchedulingPage').then((module) => ({ default: module.SchedulingPage })),
);
const ClinicResourcesPage = lazy(() =>
  import('./pages/ClinicResourcesPage').then((module) => ({ default: module.ClinicResourcesPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPages').then((module) => ({ default: module.SettingsPage })),
);
const AuditPage = lazy(() =>
  import('./pages/AuditPage').then((module) => ({ default: module.AuditPage })),
);
const BillingPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.BillingPage })),
);
const LibraryPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.LibraryPage })),
);
const DiscoverPage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.DiscoverPage })),
);
const BookingPage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.BookingPage })),
);
const IntakePage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.IntakePage })),
);
const MyCarePage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.MyCarePage })),
);
const MyRecordPage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.MyRecordPage })),
);
const MessagesPage = lazy(() =>
  import('./pages/PatientPages').then((module) => ({ default: module.MessagesPage })),
);
const AppointmentsPage = lazy(() =>
  import('./pages/ClinicPages').then((module) => ({ default: module.AppointmentsPage })),
);
const PatientsPage = lazy(() =>
  import('./pages/ClinicPages').then((module) => ({ default: module.PatientsPage })),
);
const PatientDetailPage = lazy(() =>
  import('./pages/ClinicPages').then((module) => ({ default: module.PatientDetailPage })),
);
const FollowUpsPage = lazy(() =>
  import('./pages/FollowUpPages').then((module) => ({ default: module.FollowUpsPage })),
);
const InvestigationWorklistPage = lazy(() =>
  import('./pages/InvestigationWorklistPage').then((module) => ({
    default: module.InvestigationWorklistPage,
  })),
);
const ActivityPage = lazy(() =>
  import('./pages/ActivityPage').then((module) => ({ default: module.ActivityPage })),
);
const WaitlistPage = lazy(() =>
  import('./pages/WaitlistPage').then((module) => ({ default: module.WaitlistPage })),
);
const InsightsPage = lazy(() =>
  import('./pages/InsightsPage').then((module) => ({ default: module.InsightsPage })),
);
const ExpensesPage = lazy(() =>
  import('./pages/ExpensesPage').then((module) => ({ default: module.ExpensesPage })),
);
const CareSummaryPage = lazy(() =>
  import('./pages/CareSummaryPage').then((module) => ({ default: module.CareSummaryPage })),
);
const InventoryPage = lazy(() =>
  import('./pages/InventoryPage').then((module) => ({ default: module.InventoryPage })),
);
const PatientProfilePage = lazy(() =>
  import('./pages/PatientProfilePage').then((module) => ({ default: module.PatientProfilePage })),
);
import type { Role } from '../shared/types';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <Link to="/" className={`brand ${small ? 'brand-small' : ''}`} aria-label="Derma home">
      <span className="brand-mark">
        <Activity size={23} strokeWidth={2} />
      </span>
      <span>
        derma<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}
function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { session, loading, error, refresh } = useSession();
  const location = useLocation();
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={refresh} />;
  if (!session.user)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  if (session.user.mustChangePassword && location.pathname !== '/account')
    return <Navigate to="/account?required=1" replace />;
  if (roles && !roles.includes(session.user.role))
    return <Navigate to={session.user.role === 'patient' ? '/my-care' : '/clinic'} replace />;
  return children;
}
function PublicLayout() {
  const { session } = useSession();
  return (
    <div className="public-layout">
      <header className="public-header">
        <Brand />
        <nav aria-label="Public navigation">
          <NavLink to="/" end>
            Find your dermatologist
          </NavLink>
          <NavLink to="/intake">Prepare for your visit</NavLink>
          <NavLink to="/library">Clinic library</NavLink>
        </nav>
        <Link
          className="button button-primary"
          to={session.user ? (session.user.role === 'patient' ? '/my-care' : '/clinic') : '/login'}
        >
          {session.user ? 'Open workspace' : 'Sign in'} <ArrowUpRight size={16} />
        </Link>
      </header>
      {session.demoMode && (
        <div className="public-demo">
          <span className="live-dot" /> Demonstration clinic · All profiles and patient records are
          fictional
        </div>
      )}
      <main id="main">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="public-footer">
        <Brand small />
        <span>Thoughtful care. Every step of the way.</span>
        <span>Dermatology, connected.</span>
      </footer>
    </div>
  );
}
const staffNav = [
  { to: '/clinic', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/clinic/appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/clinic/waitlist', label: 'Waitlist', icon: ClipboardList },
  { to: '/clinic/scheduling', label: 'Schedules & closures', icon: Clock3 },
  { to: '/clinic/resources', label: 'Rooms & equipment', icon: DoorOpen },
  { to: '/clinic/patients', label: 'Patients', icon: Users },
  { to: '/clinic/follow-ups', label: 'Follow-up care', icon: HeartHandshake, clinical: true },
  {
    to: '/clinic/investigations',
    label: 'Investigation reviews',
    icon: FileCheck2,
    clinical: true,
  },
  { to: '/clinic/activity', label: 'Activity', icon: Bell, clinical: true },
  { to: '/clinic/billing', label: 'Billing', icon: Receipt },
  { to: '/clinic/inventory', label: 'Inventory', icon: Package },
  { to: '/clinic/knowledge', label: 'Knowledge library', icon: BookOpen, clinical: true },
];
const adminPageLabels: Record<string, string> = {
  '/clinic/insights': 'Clinic reports',
  '/clinic/expenses': 'Expenses',
  '/clinic/accounts': 'Accounts & access',
  '/clinic/settings': 'Clinic settings',
  '/clinic/audit': 'Activity log',
};
function WorkspaceLayout({ patient = false }: { patient?: boolean }) {
  const { session, refresh } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const user = session.user!;
  const activity = useResource<ActivityFeed>(
    user.role !== 'receptionist' ? '/api/activity?limit=1' : null,
  );
  useEffect(() => {
    if (user.role !== 'receptionist') void activity.reload();
  }, [location.pathname, activity.reload, user.role]);
  useEffect(() => {
    const refresh = () => {
      if (user.role !== 'receptionist') void activity.reload();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('derma:activity-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('derma:activity-changed', refresh);
    };
  }, [activity.reload, user.role]);
  const nav = patient
    ? [
        { to: '/my-care', label: 'My care', icon: HeartHandshake, end: true },
        { to: '/my-care/record', label: 'My health record', icon: ClipboardList },
        { to: '/my-care/details', label: 'My details', icon: Users },
        { to: '/my-care/summary', label: 'Care summary', icon: FileText },
        { to: '/my-care/messages', label: 'Clinic messages', icon: MessageSquare },
        { to: '/my-care/activity', label: 'Activity', icon: Bell },
        { to: '/my-care/invoices', label: 'My invoices', icon: Receipt },
        { to: '/my-care/library', label: 'Clinic library', icon: BookOpen },
        { to: '/book', label: 'Book a visit', icon: CalendarDays },
      ]
    : staffNav.filter((item) => !item.clinical || user.role !== 'receptionist');
  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      navigate('/login', { replace: true });
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-selector">
          <span className="clinic-emblem">
            <Sparkles size={18} />
          </span>
          <span>
            <strong>{patient ? 'Your care space' : 'Derma clinic'}</strong>
            <small>{patient ? 'Connected to your clinic' : 'Clinic workspace'}</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <p className="nav-caption">{patient ? 'YOUR HEALTH' : 'WORKSPACE'}</p>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item && item.end}
              onClick={() => setMenu(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <item.icon size={19} />
              {item.label}
              {item.label === 'Activity' && !!activity.data?.unreadCount && (
                <span className="activity-nav-count" aria-hidden="true">
                  {activity.data.unreadCount > 99 ? '99+' : activity.data.unreadCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {!patient && user.role === 'admin' && (
          <>
            <p className="nav-caption">MANAGE</p>
            <nav className="sidebar-nav" aria-label="Administration">
              <NavLink
                to="/clinic/insights"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <BarChart3 size={19} />
                Clinic reports
              </NavLink>
              <NavLink
                to="/clinic/expenses"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <Wallet size={19} />
                Expenses
              </NavLink>
              <NavLink
                to="/clinic/settings"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <Settings size={19} />
                Clinic settings
              </NavLink>
              <NavLink
                to="/clinic/accounts"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <Users size={19} />
                Accounts & access
              </NavLink>
              <NavLink
                to="/clinic/audit"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <ShieldCheck size={19} />
                Activity log
              </NavLink>
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="care-symbol">✦</span>
            <strong>Care that stays connected.</strong>
            <p>A clearer journey, from the first visit to the next milestone.</p>
            <Link to="/">
              Explore your clinic <ArrowUpRight size={14} />
            </Link>
          </div>
          <Link className="nav-item" to="/account" onClick={() => setMenu(false)}>
            <CircleHelp size={19} />
            Account & security
          </Link>
          <button className="user-card" onClick={logout} title="Sign out">
            <Avatar name={user.name} size="sm" />
            <span>
              <strong>{user.name}</strong>
              <small>{user.role === 'admin' ? 'Clinic administrator' : user.role}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="row topbar-left">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb">
              {patient ? 'My care' : 'Workspace'}
              <span>/</span>
              <strong>
                {nav.find((n) =>
                  n.end ? location.pathname === n.to : location.pathname.startsWith(n.to),
                )?.label ||
                  adminPageLabels[location.pathname] ||
                  'Account'}
              </strong>
            </span>
          </div>
          <div className="topbar-right">
            {user.role !== 'receptionist' && (
              <Link
                to={patient ? '/my-care/activity' : '/clinic/activity'}
                className="activity-bell"
                aria-label={`Activity${activity.data?.unreadCount ? `, ${activity.data.unreadCount} unread` : ''}`}
              >
                <Bell size={17} />
                {!!activity.data?.unreadCount && (
                  <span className="activity-bell-count" aria-hidden="true">
                    {activity.data.unreadCount > 99 ? '99+' : activity.data.unreadCount}
                  </span>
                )}
              </Link>
            )}
            {!patient && (
              <form
                className="global-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(`/clinic/patients?search=${encodeURIComponent(query)}`);
                }}
              >
                <Search size={16} />
                <input
                  aria-label="Search patients"
                  placeholder="Find a patient…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>↵</kbd>
              </form>
            )}
            <Link to="/" className="view-clinic">
              View clinic <ArrowUpRight size={14} />
            </Link>
            <span className="topbar-divider" />
            <Avatar name={user.name} size="sm" />
          </div>
        </header>
        <main id="main" className="workspace-main">
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="workspace-footer">
          <span>
            <span className="live-dot" />
            {session.demoMode ? 'Demo workspace · Synthetic data only' : 'Connected to your clinic'}
          </span>
          <span>Made for more human care.</span>
        </footer>
      </div>
    </div>
  );
}
export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<DiscoverPage />} />
          <Route path="login" element={<AuthPage />} />
          <Route path="register" element={<AuthPage register />} />
          <Route path="recover" element={<RecoveryPage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route
            path="book"
            element={
              <Guard>
                <BookingPage />
              </Guard>
            }
          />
          <Route
            path="intake"
            element={
              <Guard roles={['patient']}>
                <IntakePage />
              </Guard>
            }
          />
        </Route>
        <Route
          element={
            <Guard roles={['admin', 'doctor', 'receptionist']}>
              <WorkspaceLayout />
            </Guard>
          }
        >
          <Route path="clinic" element={<DashboardPage />} />
          <Route path="clinic/scheduling" element={<SchedulingPage />} />
          <Route path="clinic/resources" element={<ClinicResourcesPage />} />
          <Route
            path="clinic/accounts"
            element={
              <Guard roles={['admin']}>
                <AccountsPage />
              </Guard>
            }
          />
          <Route path="clinic/billing" element={<BillingPage />} />
          <Route path="clinic/inventory" element={<InventoryPage />} />
          <Route path="clinic/waitlist" element={<WaitlistPage />} />
          <Route
            path="clinic/insights"
            element={
              <Guard roles={['admin']}>
                <InsightsPage />
              </Guard>
            }
          />
          <Route
            path="clinic/expenses"
            element={
              <Guard roles={['admin']}>
                <ExpensesPage />
              </Guard>
            }
          />
          <Route
            path="clinic/activity"
            element={
              <Guard roles={['admin', 'doctor']}>
                <ActivityPage />
              </Guard>
            }
          />
          <Route
            path="clinic/knowledge"
            element={
              <Guard roles={['admin', 'doctor']}>
                <LibraryPage manage />
              </Guard>
            }
          />
          <Route path="clinic/appointments" element={<AppointmentsPage />} />
          <Route path="clinic/patients" element={<PatientsPage />} />
          <Route path="clinic/patients/:id/details" element={<PatientProfilePage />} />
          <Route
            path="clinic/patients/:id"
            element={
              <Guard roles={['admin', 'doctor']}>
                <PatientDetailPage />
              </Guard>
            }
          />
          <Route
            path="clinic/patients/:id/summary"
            element={
              <Guard roles={['admin', 'doctor']}>
                <CareSummaryPage />
              </Guard>
            }
          />
          <Route
            path="clinic/investigations"
            element={
              <Guard roles={['admin', 'doctor']}>
                <InvestigationWorklistPage />
              </Guard>
            }
          />
          <Route
            path="clinic/follow-ups"
            element={
              <Guard roles={['admin', 'doctor']}>
                <FollowUpsPage />
              </Guard>
            }
          />
          <Route
            path="clinic/settings"
            element={
              <Guard roles={['admin']}>
                <SettingsPage />
              </Guard>
            }
          />
          <Route
            path="clinic/audit"
            element={
              <Guard roles={['admin']}>
                <AuditPage />
              </Guard>
            }
          />
        </Route>
        <Route
          element={
            <Guard roles={['patient']}>
              <WorkspaceLayout patient />
            </Guard>
          }
        >
          <Route path="my-care" element={<MyCarePage />} />
          <Route path="my-care/invoices" element={<BillingPage />} />
          <Route path="my-care/library" element={<LibraryPage />} />
          <Route path="my-care/record" element={<MyRecordPage />} />
          <Route path="my-care/details" element={<PatientProfilePage />} />
          <Route path="my-care/summary" element={<CareSummaryPage />} />
          <Route path="my-care/messages" element={<MessagesPage />} />
          <Route path="my-care/activity" element={<ActivityPage />} />
        </Route>
        <Route
          path="account"
          element={
            <Guard>
              <SecurityPage />
            </Guard>
          }
        />
        <Route
          path="*"
          element={
            <div className="not-found">
              <Brand />
              <h1>Let’s get you back on track.</h1>
              <p>This page doesn’t exist.</p>
              <Link className="button button-primary" to="/">
                Back to the clinic
              </Link>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}
