// k6 load test: ingest throughput and latency (and, with DEST_URL, delivery fan-out).
//
//   k6 run load/ingest.js                                   # inspection-only endpoint
//   k6 run -e DEST_URL=http://127.0.0.1:4100/ok load/ingest.js
//   k6 run -e RATE=500 -e DURATION=30s -e BASE_URL=http://127.0.0.1:3100 load/ingest.js
//
// The server must allow the Origin (APP_ORIGIN) and have ingest limits raised for the run
// (INGEST_RATE_PER_SECOND / INGEST_BURST), or most requests are 429 by design.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    ingest: {
      // Open model: a fixed arrival rate, whatever the latency (closer to real webhook traffic
      // than N looping users, which slow down when the server does and hide the problem).
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: {
    'http_req_failed{name:ingest}': ['rate<0.01'],
    'http_req_duration{name:ingest}': ['p(95)<250'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function json(method, path, body, cookie) {
  const headers = { 'content-type': 'application/json', origin: BASE };
  if (cookie) headers.cookie = cookie;
  return http.request(method, `${BASE}${path}`, JSON.stringify(body), {
    headers,
    tags: { name: 'setup' },
  });
}

export function setup() {
  const email = `k6-${Date.now()}@example.test`;
  const signup = json('POST', '/api/v1/auth/signup', { email, password: 'k6-load-test-password' });
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${signup.body}`);
  // The __Host- cookie is Secure; k6's jar won't replay it over http, so pass it by hand.
  const setCookie = signup.headers['Set-Cookie'] || '';
  const cookie = setCookie.split(';')[0];

  const ep = json('POST', '/api/v1/endpoints', { name: `k6 ${RATE} rps` }, cookie);
  if (ep.status !== 201) throw new Error(`endpoint failed: ${ep.status} ${ep.body}`);
  const endpoint = ep.json('endpoint');

  if (__ENV.DEST_URL) {
    const dest = json(
      'POST',
      `/api/v1/endpoints/${endpoint.id}/destinations`,
      { url: __ENV.DEST_URL },
      cookie,
    );
    if (dest.status !== 201) throw new Error(`destination failed: ${dest.status} ${dest.body}`);
  }
  console.log(`endpoint ${endpoint.id} (slug ${endpoint.slug})`);
  return { slug: endpoint.slug, endpointId: endpoint.id };
}

const payload = JSON.stringify({
  type: 'invoice.paid',
  data: { id: 'in_123', amount: 4200, currency: 'inr', customer: 'cus_456', lines: [1, 2, 3] },
});

export default function (data) {
  const res = http.post(`${BASE}/in/${data.slug}`, payload, {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'ingest' },
  });
  check(res, { 'status is 202': (r) => r.status === 202 });
}
