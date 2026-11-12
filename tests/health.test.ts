import { expect, it } from 'vitest';
import { createApp } from '../src/web/app.js';
import { testDeps } from './helpers.js';

it('GET /health returns 200 ok when the db answers', async () => {
  const res = await createApp(testDeps()).request('/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it('GET /health returns 503 when the db fails', async () => {
  const deps = testDeps();
  deps.db.close();
  const res = await createApp(deps).request('/health');
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false });
});
