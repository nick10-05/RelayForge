// Endpoint settings for incoming requests: signature verification and de-duplication.
// Both were API-only before. The verification secret is write-only: the API never returns it,
// so the form says whether one is set and asks for it again whenever the config is saved.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { patch } from '../api.ts';
import { Button, Card, ErrorText, Field, SelectField } from '../components/ui.tsx';
import {
  HMAC_PRESETS,
  dedupePayload,
  describeVerification,
  verificationForm,
  verificationPayload,
} from '../lib/inbound-settings.ts';
import type { DedupeForm, Scheme, VerificationForm } from '../lib/inbound-settings.ts';
import type { Endpoint } from '../types.ts';

const SCHEMES = [
  { value: 'none', label: 'Off' },
  { value: 'hmac', label: 'HMAC-SHA256 (GitHub, Shopify, most providers)' },
  { value: 'standard_webhooks', label: 'Standard Webhooks (Svix-based providers)' },
] as const satisfies readonly { value: Scheme; label: string }[];

const DEDUPE_SOURCES = [
  { value: 'none', label: 'Off' },
  { value: 'header', label: 'A request header' },
  { value: 'json_field', label: 'A top-level JSON field' },
] as const satisfies readonly { value: DedupeForm['source']; label: string }[];

export function InboundSettings({
  endpoint,
  onSaved,
}: {
  endpoint: Endpoint;
  onSaved: () => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Incoming requests</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <VerificationCard endpoint={endpoint} onSaved={onSaved} />
        <DedupeCard endpoint={endpoint} onSaved={onSaved} />
      </div>
    </section>
  );
}

function VerificationCard({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const [form, setForm] = useState<VerificationForm>(() => verificationForm(endpoint.verification));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (patchForm: Partial<VerificationForm>) => {
    setForm((f) => ({ ...f, ...patchForm }));
    setSaved(false);
  };

  const save = useMutation({
    mutationFn: (verification: unknown) =>
      patch(`/api/v1/endpoints/${endpoint.id}`, { verification }),
    onSuccess: () => {
      setForm((f) => ({ ...f, secret: '' })); // never keep the secret around after saving
      setSaved(true);
      onSaved();
    },
  });

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-medium">Signature verification</h3>
        <p className="text-xs text-slate-500">Now: {describeVerification(endpoint.verification)}</p>
      </div>
      <p className="text-sm text-slate-600">
        Requests that fail the check get <code>401</code>, are kept for 24 h so you can see why, and
        are never forwarded or replayable.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const payload = verificationPayload(form);
          if (typeof payload === 'string') {
            setProblem(payload);
            return;
          }
          setProblem(null);
          save.mutate(payload);
        }}
      >
        <SelectField
          label="Scheme"
          value={form.scheme}
          options={SCHEMES}
          onChange={(scheme) => set({ scheme })}
        />
        {form.scheme === 'hmac' && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              Presets:
              {HMAC_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50"
                  onClick={() => set({ header: p.header, prefix: p.prefix, encoding: p.encoding })}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem]">
              <Field
                label="Signature header"
                placeholder="x-hub-signature-256"
                value={form.header}
                onChange={(e) => set({ header: e.target.value })}
              />
              <Field
                label="Prefix"
                placeholder="sha256="
                value={form.prefix}
                onChange={(e) => set({ prefix: e.target.value })}
              />
              <SelectField
                label="Encoding"
                value={form.encoding}
                options={[
                  { value: 'hex', label: 'hex' },
                  { value: 'base64', label: 'base64' },
                ]}
                onChange={(encoding) => set({ encoding })}
              />
            </div>
          </>
        )}
        {form.scheme !== 'none' && (
          <Field
            label="Signing secret"
            type="password"
            autoComplete="off"
            placeholder={form.scheme === 'standard_webhooks' ? 'whsec_...' : 'from the provider'}
            hint={
              endpoint.verification.hasSecret
                ? 'A secret is saved. It is never shown; enter it again to save any change.'
                : 'Stored encrypted (AES-256-GCM) and never shown again.'
            }
            value={form.secret}
            onChange={(e) => set({ secret: e.target.value })}
          />
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            Save verification
          </Button>
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
        </div>
        {problem && (
          <p role="alert" className="text-sm text-red-700">
            {problem}
          </p>
        )}
        <ErrorText error={save.error} />
      </form>
    </Card>
  );
}

function DedupeCard({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const [form, setForm] = useState<DedupeForm>({
    source: endpoint.dedupeSource,
    name: endpoint.dedupeName ?? '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: object) => patch(`/api/v1/endpoints/${endpoint.id}`, body),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
  });

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-medium">De-duplication</h3>
        <p className="text-xs text-slate-500">
          Now:{' '}
          {endpoint.dedupeSource === 'none'
            ? 'off: every request is a new event.'
            : `on ${endpoint.dedupeSource === 'header' ? 'header' : 'JSON field'} "${endpoint.dedupeName ?? ''}"`}
        </p>
      </div>
      <p className="text-sm text-slate-600">
        Providers retry. With a key, a repeat of an event already stored gets <code>200</code> with
        the original id and is counted, not forwarded again.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const payload = dedupePayload(form);
          if (typeof payload === 'string') {
            setProblem(payload);
            return;
          }
          setProblem(null);
          save.mutate(payload);
        }}
      >
        <SelectField
          label="Event id comes from"
          value={form.source}
          options={DEDUPE_SOURCES}
          onChange={(source) => {
            setForm((f) => ({ ...f, source }));
            setSaved(false);
          }}
        />
        {form.source !== 'none' && (
          <Field
            label={form.source === 'header' ? 'Header name' : 'JSON field'}
            placeholder={form.source === 'header' ? 'x-github-delivery' : 'id'}
            value={form.name}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
              setSaved(false);
            }}
          />
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            Save de-duplication
          </Button>
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
        </div>
        {problem && (
          <p role="alert" className="text-sm text-red-700">
            {problem}
          </p>
        )}
        <ErrorText error={save.error} />
      </form>
    </Card>
  );
}
