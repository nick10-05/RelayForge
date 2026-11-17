import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useLogin, useMe } from '../auth.tsx';
import { Globe } from '../components/globe/Globe.tsx';
import { Button, ErrorText, Field, Wordmark } from '../components/ui.tsx';
import { safeNext } from '../lib/safe-next.ts';

export function LoginPage({ mode }: { mode: 'login' | 'signup' }) {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const me = useMe();
  const login = useLogin(mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me.data) return <Navigate to={next} replace />;

  const signup = mode === 'signup';
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(420px,1fr)_1.15fr]">
      <div className="relative flex flex-col px-6 py-6 sm:px-12">
        <Link to="/" className="self-start">
          <Wordmark />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <div className="animate-rise space-y-8">
            <div className="space-y-2">
              <p className="eyebrow text-ember-400">{signup ? 'Get started' : 'Welcome back'}</p>
              <h1 className="text-3xl font-semibold tracking-tight">
                {signup ? 'Create your account' : 'Sign in to RelayForge'}
              </h1>
              <p className="text-sm text-muted">
                {signup
                  ? 'Free to use. Your first endpoint takes about a minute.'
                  : 'Your endpoints, events and deliveries are waiting.'}
              </p>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                login.mutate(
                  { email, password },
                  { onSuccess: () => void navigate(next, { replace: true }) },
                );
              }}
            >
              <Field
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Field
                label="Password"
                type="password"
                autoComplete={signup ? 'new-password' : 'current-password'}
                required
                minLength={signup ? 12 : 1}
                {...(signup && { hint: 'At least 12 characters. Stored as an Argon2id hash.' })}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <ErrorText error={login.error} />
              <Button type="submit" className="w-full py-2.5" disabled={login.isPending}>
                {login.isPending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
              </Button>
            </form>
            <p className="text-sm text-muted">
              {signup ? 'Already have an account? ' : 'New to RelayForge? '}
              <Link
                to={`${signup ? '/login' : '/signup'}?next=${encodeURIComponent(next)}`}
                className="font-medium text-ember-300 hover:text-ember-200"
              >
                {signup ? 'Sign in' : 'Create an account'}
              </Link>
            </p>
          </div>
        </div>
      </div>

      <aside className="relative hidden overflow-hidden border-l border-ink-700/70 bg-ink-900/60 lg:block">
        <div
          aria-hidden="true"
          className="dot-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
        />
        <div className="absolute inset-0 grid place-items-center p-10">
          <div className="aspect-square w-full max-w-[620px]">
            <Globe />
          </div>
        </div>
        <div className="absolute inset-x-10 bottom-10 space-y-3">
          <p className="max-w-md font-display text-3xl leading-tight text-fg/90 italic">
            Stored before acknowledged. Retried until delivered. Explained when it isn&apos;t.
          </p>
          <p className="font-mono text-[11px] text-dim">
            AT-LEAST-ONCE DELIVERY · SIGNED · SSRF-GUARDED
          </p>
        </div>
      </aside>
    </div>
  );
}
