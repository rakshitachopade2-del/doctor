import { useState, type ReactNode } from 'react';
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
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Search,
  BookOpen,
  Receipt,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { useSession, api, useToast } from './lib';
import { Avatar, Badge, ErrorState, Loading } from './components/ui';
import { AuthPage, AccountPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage, AuditPage } from './pages/SettingsPages';
import { BillingPage, LibraryPage } from './pages/OperationsPages';
import './operations.css';
import {
  DiscoverPage,
  BookingPage,
  IntakePage,
  MyCarePage,
  MyRecordPage,
  MessagesPage,
} from './pages/PatientPages';
import {
  AppointmentsPage,
  PatientsPage,
  PatientDetailPage,
  FollowUpsPage,
} from './pages/ClinicPages';
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
        <Outlet />
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
  { to: '/clinic/patients', label: 'Patients', icon: Users },
  { to: '/clinic/follow-ups', label: 'Follow-up care', icon: HeartHandshake, clinical: true },
  { to: '/clinic/billing', label: 'Billing', icon: Receipt },
  { to: '/clinic/knowledge', label: 'Knowledge library', icon: BookOpen, clinical: true },
];
function WorkspaceLayout({ patient = false }: { patient?: boolean }) {
  const { session, refresh } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const user = session.user!;
  const nav = patient
    ? [
        { to: '/my-care', label: 'My care', icon: HeartHandshake, end: true },
        { to: '/my-care/record', label: 'My health record', icon: ClipboardList },
        { to: '/my-care/messages', label: 'Clinic messages', icon: MessageSquare },
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
            </NavLink>
          ))}
        </nav>
        {!patient && user.role === 'admin' && (
          <>
            <p className="nav-caption">MANAGE</p>
            <nav className="sidebar-nav" aria-label="Administration">
              <NavLink
                to="/clinic/settings"
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setMenu(false)}
              >
                <Settings size={19} />
                Clinic settings
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
          <div className="row">
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
                  (location.pathname.includes('settings')
                    ? 'Clinic settings'
                    : location.pathname.includes('audit')
                      ? 'Activity log'
                      : 'Account')}
              </strong>
            </span>
          </div>
          <div className="topbar-right">
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
          <Outlet />
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
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<DiscoverPage />} />
        <Route path="login" element={<AuthPage />} />
        <Route path="register" element={<AuthPage register />} />
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
        <Route path="clinic/billing" element={<BillingPage />} />
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
        <Route
          path="clinic/patients/:id"
          element={
            <Guard roles={['admin', 'doctor']}>
              <PatientDetailPage />
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
        <Route path="my-care/messages" element={<MessagesPage />} />
      </Route>
      <Route
        path="account"
        element={
          <Guard>
            <AccountPage />
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
  );
}
