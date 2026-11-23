import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import type { Session } from '../../shared/types';

export const patientId = 'patient-ananya';
export const portal = '/my-care/record?tab=workflows';
export const clinic = '/clinic/patients/' + patientId + '?tab=workup';
export const workflows = '/api/patients/' + patientId + '/clinical-workflows';
export const path = (plan: ProcedureRecord) => '/api/procedures/' + plan.id;
export const dialog = (page: Page) => page.getByRole('dialog');
export const button = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
export const title = (page: Page, name: string) =>
  dialog(page).getByRole('heading', { name, exact: true });
export const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
export const checkbox = (page: Page) => dialog(page).getByRole('checkbox');
export type Actor = { api: APIRequestContext; session: Session };

export async function login(
  api: APIRequestContext,
  role: 'admin' | 'doctor' | 'patient',
): Promise<Actor> {
  const response = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  return { api, session: await response.json() };
}
// Auxiliary accounts never sign out. Give each worker its own API sessions so that the
// number of browser scenarios does not exhaust the application's sign-in limit.
export const test = base.extend<{}, { admin: Actor; patient: Actor }>({
  admin: [
    async ({ playwright }, use, worker) => {
      const api = await playwright.request.newContext({ baseURL: worker.project.use.baseURL });
      try {
        await use(await login(api, 'admin'));
      } finally {
        await api.dispose();
      }
    },
    { scope: 'worker' },
  ],
  patient: [
    async ({ playwright }, use, worker) => {
      const api = await playwright.request.newContext({ baseURL: worker.project.use.baseURL });
      try {
        await use(await login(api, 'patient'));
      } finally {
        await api.dispose();
      }
    },
    { scope: 'worker' },
  ],
});
export async function read<T>(who: Actor, url: string): Promise<T> {
  const response = await who.api.get(url);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
export async function post<T>(who: Actor, url: string, data: unknown, status = 201): Promise<T> {
  const response = await who.api.post(url, {
    headers: { 'X-CSRF-Token': who.session.csrfToken! },
    data,
  });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
export async function planFor(admin: Actor, appointmentId: string | null = null) {
  return post<ProcedureRecord>(admin, '/api/procedures', {
    patientId,
    appointmentId,
    title: 'Procedure ' + randomUUID().slice(0, 8),
    indication: 'Synthetic procedure workflow.',
    benefits: 'Discussed potential benefit.',
    risks: 'Discussed potential risk.',
    alternatives: 'Discussed other options.',
    aftercare: 'Synthetic aftercare.',
    estimatedCost: 'No charge for this test.',
  });
}
export async function current(who: Actor, plan: ProcedureRecord) {
  const record = await read<PatientClinicalWorkflows>(who, workflows);
  return record.procedures.find((p) => p.id === plan.id)!;
}
export function card(page: Page, plan: ProcedureRecord, role: 'patient' | 'doctor' = 'patient') {
  return page
    .locator(role === 'patient' ? '.patient-procedure-card' : '.cw-procedure')
    .filter({ has: page.getByRole('heading', { name: plan.title, exact: true }) });
}
export async function mobile(page: Page, action: string, screenshot: string) {
  await page.setViewportSize({ width: 320, height: 800 });
  const target = button(page, action);
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(
    await target.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
    }),
  ).toBe(true);
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: screenshot });
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
