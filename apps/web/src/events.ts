// Data hooks for events and redelivery. Pages call these; they never call fetch directly.
//
// Live updates are polling, not SSE (design: SSE is "later"): one cheap indexed query every few
// seconds, only while the tab is visible (TanStack Query pauses intervals in the background),
// no long-lived connections to keep alive through the host's proxy, and nothing new to scale.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from './api.ts';
import type { Delivery, EventDetail, EventPage } from './types.ts';

export const LIST_POLL_MS = 5_000;
export const DETAIL_POLL_MS = 3_000;
const PAGE_SIZE = 50;

export const eventListKey = (endpointId: string) => ['events', endpointId] as const;
export const eventKey = (eventId: string) => ['event', eventId] as const;

/**
 * Newest-first event list with "load older" (keyset cursor from the API). Polling refetches the
 * pages already loaded, so new events appear at the top without losing the user's place.
 */
export function useEventList(endpointId: string) {
  return useInfiniteQuery({
    queryKey: eventListKey(endpointId),
    queryFn: ({ pageParam }) =>
      get<EventPage>(
        `/api/v1/endpoints/${endpointId}/events?limit=${PAGE_SIZE}` +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: LIST_POLL_MS,
  });
}

/** True while the engine may still change this delivery (worth polling for). */
export const isActive = (d: Pick<Delivery, 'status'>) =>
  d.status === 'pending' || d.status === 'in_flight';

/** One event with deliveries and attempt history. Polls only while a delivery is still active. */
export function useEvent(eventId: string) {
  return useQuery({
    queryKey: eventKey(eventId),
    queryFn: async () => (await get<{ event: EventDetail }>(`/api/v1/events/${eventId}`)).event,
    refetchInterval: (query) =>
      query.state.data?.deliveries.some(isActive) ? DETAIL_POLL_MS : false,
  });
}

/**
 * Retry one dead delivery: POST /deliveries/:id/retry.
 *   202 { deliveryId }                         a new manual delivery was queued
 *   409 active_delivery_exists { deliveryId }  one is already pending (double click) — not an error
 *   422 delivery_not_dead | invalid_signature
 */
export function useRetryDelivery(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      post<{ deliveryId: string }>(`/api/v1/deliveries/${deliveryId}/retry`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: eventKey(eventId) }),
  });
}

/**
 * Replay the whole event to every enabled destination (or the given ones):
 * POST /events/:id/replay.
 *   202 { deliveries: [{ destinationId, deliveryId, created }] }
 *   409 active_delivery_exists — every destination already has a pending delivery
 *   422 invalid_signature | no_destinations
 */
export function useReplayEvent(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (destinationIds?: string[]) =>
      post<{ deliveries: { destinationId: string; deliveryId: string; created: boolean }[] }>(
        `/api/v1/events/${eventId}/replay`,
        destinationIds ? { destinationIds } : {},
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: eventKey(eventId) }),
  });
}

/** Raw stored bytes as a download (never rendered: served as octet-stream + attachment). */
export const rawBodyUrl = (eventId: string) => `/api/v1/events/${eventId}/body`;
