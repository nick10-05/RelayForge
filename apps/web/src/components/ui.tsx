// Small shared UI pieces. Plain Tailwind classes on the design tokens in index.css, no
// component library.
import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { ApiError } from '../api.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ember-500 text-ink-950 shadow-[0_0_0_1px_rgb(255_141_88/0.5),0_6px_20px_-6px_rgb(255_106_43/0.6)] hover:bg-ember-400',
  secondary: 'border border-ink-600 bg-ink-800 text-fg hover:border-ink-500 hover:bg-ink-750',
  ghost: 'text-muted hover:bg-ink-800 hover:text-fg',
  danger: 'border border-rose-500/40 bg-rose-500/5 text-rose-300 hover:bg-rose-500/15',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

/** The same look as Button, for router links and anchors. */
export const buttonClass = (variant: Variant = 'primary', extra = '') =>
  `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${VARIANTS[variant]} ${extra}`;

const INPUT =
  'block w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-dim transition-colors focus:border-ember-500/70 focus:ring-2 focus:ring-ember-500/20 focus:outline-none';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input className={INPUT} {...props} />
      {hint && <span className="block text-xs text-dim">{hint}</span>}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select className={INPUT} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel p-5 ${className}`}>{children}</div>;
}

const TONES = {
  slate: 'border-ink-600 bg-ink-800 text-muted',
  green: 'border-mint-400/25 bg-mint-400/10 text-mint-300',
  amber: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  red: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  ember: 'border-ember-400/30 bg-ember-500/10 text-ember-300',
  ice: 'border-ice-400/25 bg-ice-400/10 text-ice-300',
};
export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = 'slate',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** A small pulsing dot: something is live / being polled. */
export function LiveDot({ tone = 'mint' }: { tone?: 'mint' | 'ember' | 'amber' | 'rose' }) {
  const color = {
    mint: 'bg-mint-400 text-mint-400',
    ember: 'bg-ember-400 text-ember-400',
    amber: 'bg-amber-400 text-amber-400',
    rose: 'bg-rose-400 text-rose-400',
  }[tone];
  return (
    <span className={`inline-block size-2 shrink-0 animate-pulse-dot rounded-full ${color}`} />
  );
}

/** The RelayForge mark: a signal entering a node and leaving forged (ember). */
export function Logo({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="rf-ember" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb18a" />
          <stop offset="1" stopColor="#ff6a2b" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#0c1017" stroke="#2a3243" />
      <path
        d="M6 20.5h6.5"
        stroke="#82a9ff"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path d="M19.5 11.5H26" stroke="url(#rf-ember)" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M12.5 20.5c3.5 0 3.5-9 7-9"
        fill="none"
        stroke="url(#rf-ember)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.4" fill="#ffd2b8" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className="text-[15px] font-semibold tracking-tight">
        Relay<span className="text-ember-400">Forge</span>
      </span>
    </span>
  );
}

/** Page title block: eyebrow, title, optional description and actions on the right. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {description && <p className="max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** The API's message for an ApiError (plus the first validation issue), a generic one otherwise. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = (error.body as { issues?: { path: string; message: string }[] } | undefined)
      ?.issues;
    const first = issues?.[0];
    if (!first) return error.message;
    const field = first.path.replace(/^\//, '').replaceAll('/', '.');
    return `${error.message}: ${field ? `${field} ` : ''}${first.message}`;
  }
  return 'Something went wrong. Check your connection and try again.';
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-rose-300">
      {errorMessage(error)}
    </p>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      className="shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <span className="text-mint-300">Copied</span> : label}
    </Button>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center gap-3 py-6 text-sm text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-ink-600 border-t-ember-400" />
      Loading…
    </div>
  );
}

/** A dark "terminal" strip for URLs, commands and secrets, with a copy button. */
export function CodeLine({ value, prompt }: { value: string; prompt?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 py-1.5 pr-1.5 pl-3">
      {prompt && <span className="font-mono text-xs text-ember-400 select-none">{prompt}</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg/90" title={value}>
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}
