// Response shapes of the RelayForge API (apps/server). Dates arrive as ISO strings.

export type User = { id: string; email: string; createdAt: string };

export type Endpoint = {
  id: string;
  name: string;
  slug: string;
  ingestPath: string;
  paused: boolean;
  dedupeSource: 'none' | 'header' | 'json_field';
  dedupeName: string | null;
  verification: {
    scheme: 'none' | 'hmac' | 'standard_webhooks';
    header: string | null;
    prefix: string | null;
    encoding: 'hex' | 'base64' | null;
    hasSecret: boolean;
  };
  createdAt: string;
};

export type Destination = {
  id: string;
  endpointId: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: string;
};
