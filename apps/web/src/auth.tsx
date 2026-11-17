// Who is logged in comes from the server (GET /auth/me), cached by TanStack Query under ['me'].
// The session cookie is HttpOnly, so JavaScript can't read it — by design (XSS can't steal it).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, get, post } from './api.ts';
import { Spinner } from './components/ui.tsx';
import type { User } from './types.ts';

const ME = ['me'] as const;

/** The current user, or null when logged out (401 is an answer here, not an error). */
export function useMe() {
  return useQuery({
    queryKey: ME,
    queryFn: async (): Promise<User | null> => {
      try {
        return (await get<{ user: User }>('/api/v1/auth/me')).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

type Credentials = { email: string; password: string };

export function useLogin(mode: 'login' | 'signup') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: Credentials) =>
      post<{ user: User }>(`/api/v1/auth/${mode}`, credentials),
    onSuccess: ({ user }) => {
      // A new session: drop anything cached for a previous user, then seed 'me'.
      queryClient.clear();
      queryClient.setQueryData(ME, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => post<undefined>('/api/v1/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(ME, null);
    },
  });
}

/** Renders children only when logged in; otherwise sends the user to /login and back after. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Spinner />;
  if (me.isError)
    return <p className="p-8 text-sm text-rose-300">Cannot reach the API right now.</p>;
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}
