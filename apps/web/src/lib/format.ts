// Display helpers shared by the event pages.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "12 s ago", "5 min ago", "3 h ago", else a local date-time. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

/** "in 25 s", "in 3 min", "now" — for scheduled retries. */
export function timeUntil(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds} s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)} min`;
  return `at ${new Date(iso).toLocaleString()}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
