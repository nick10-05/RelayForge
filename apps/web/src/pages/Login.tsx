import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useLogin, useMe } from '../auth.tsx';
import { Button, Card, ErrorText, Field } from '../components/ui.tsx';
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
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">{signup ? 'Create an account' : 'Log in'}</h1>
      <Card>
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
            {...(signup && { hint: 'At least 12 characters.' })}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorText error={login.error} />
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Please wait…' : signup ? 'Sign up' : 'Log in'}
          </Button>
        </form>
      </Card>
      <p className="text-sm text-slate-600">
        {signup ? 'Already have an account? ' : 'New here? '}
        <Link
          to={`${signup ? '/login' : '/signup'}?next=${encodeURIComponent(next)}`}
          className="text-indigo-700 underline"
        >
          {signup ? 'Log in' : 'Create an account'}
        </Link>
      </p>
    </div>
  );
}
