import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMe, signout, type ApiSession } from '../api.js';
import '../styles/account-menu.css';

export interface AccountMenuProps {
  onSignedOut: () => void;
  sessions: ApiSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onNewProject: () => void;
}

function formatSessionLabel(session: ApiSession): string {
  const date = new Date(session.createdAt);
  const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
  return `${session.phase} — ${when}`;
}

/**
 * Minimal account menu (previously nonexistent): shows the signed-in
 * user's own email (fetched via GET /api/auth/me, #account-profile — the
 * signup/signin response body is stale the instant a page reload happens),
 * a working sign-out button (the backend route existed since Epic 0.8 but
 * was never wired to any UI), and a project switcher listing every session
 * the user has ever started (#account-profile's "project list" half) —
 * previously only the single most-recent session was ever reachable.
 */
export function AccountMenu({
  onSignedOut,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewProject,
}: AccountMenuProps) {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    getMe().then((result) => {
      if (result.ok) setEmail(result.data.email);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  async function handleSignOut() {
    setSigningOut(true);
    await signout();
    setSigningOut(false);
    onSignedOut();
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <button
        type="button"
        className="account-menu__trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        {email ?? 'Account'}
      </button>
      {open && (
        <div className="account-menu__panel">
          <div className="account-menu__email">{email}</div>

          <div className="account-menu__section-label">Projects</div>
          <ul className="account-menu__projects">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={
                    session.id === activeSessionId
                      ? 'account-menu__project account-menu__project--active'
                      : 'account-menu__project'
                  }
                  onClick={() => {
                    onSelectSession(session.id);
                    setOpen(false);
                  }}
                >
                  {formatSessionLabel(session)}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="account-menu__new-project"
            onClick={() => {
              onNewProject();
              setOpen(false);
            }}
          >
            + New project
          </button>

          <button
            type="button"
            className="account-menu__new-project"
            onClick={() => {
              navigate('/account');
              setOpen(false);
            }}
          >
            Account &amp; billing
          </button>

          <button
            type="button"
            className="account-menu__signout"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
