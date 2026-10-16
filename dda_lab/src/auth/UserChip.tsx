// Signed-in user chip for the top bar (hosted app only) + a "session expired" banner.
import { useEffect, useRef, useState } from 'react';
import { loginUrl, logout, useAuth } from './client';

export default function UserChip() {
  const { loading, authEnabled, user } = useAuth();
  const [open, setOpen] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (loading || !authEnabled) return null;

  if (!user) {
    return (
      <div className="auth-banner" role="status" data-testid="auth-banner">
        You are signed out — your open files are still here.{' '}
        <a href={loginUrl('/lab/')}>Sign in</a>
      </div>
    );
  }

  const label = user.name || user.email;
  const initial = (label.trim()[0] ?? '?').toUpperCase();
  return (
    <div className="user-chip" ref={ref} data-testid="user-chip">
      <button
        className="user-chip-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
        onClick={() => setOpen((o) => !o)}
      >
        {user.avatar_url && imgOk ? (
          <img className="user-avatar" src={user.avatar_url} alt="" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
        ) : (
          <span className="user-avatar user-initial" aria-hidden="true">
            {initial}
          </span>
        )}
        <span className="user-name">{label}</span>
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head">
            <b>{label}</b>
            <small>{user.email}</small>
            {user.role === 'admin' && <small className="user-role">admin</small>}
          </div>
          <button
            role="menuitem"
            className="user-menu-item"
            data-testid="sign-out"
            onClick={async () => {
              setOpen(false);
              await logout();
              location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
