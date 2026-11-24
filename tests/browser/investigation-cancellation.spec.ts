import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type { Investigation, PatientClinicalWorkflows } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import type {
  InvestigationCancellationCommand,
  InvestigationCancellationResponse,
} from '../../shared/investigation-cancellation';
import type { Doctor, Session } from '../../shared/types';
import { syntheticPdf } from '../fixtures/report';
import {
  button,
  checkbox,
  deferred,
  dialog,
  field,
  login,
  mobile,
  post,
  read,
  test,
  title,
  type Actor,
} from './workflow-fixtures';

const patientId = 'patient-ananya';
const chart = (id = patientId) => '/clinic/patients/' + id + '?tab=workup';
const path = (order: Investigation) => '/api/investigations/' + order.id;
const endpoint = (order: Investigation) => path(order) + '/cancellation';
const resume = (page: Page, order: Investigation) =>
  page.getByRole('button', { name: 'Resume cancellation: ' + order.title, exact: true });
const reasonLabel = 'Reason for cancellation';
const save = 'Confirm cancellation';
const retry = 'Retry exact cancellation';
const saved = 'Investigation cancelled';
const refresh = 'Refresh investigation';
const reason = 'The clinic and patient agreed to cancel this synthetic request.';

function createOrder(admin: Actor, owner = patientId) {
  return post<Investigation>(admin, '/api/investigations', {
    patientId: owner,
    title: 'Synthetic investigation ' + randomUUID().slice(0, 8),
    kind: 'other',
    reason: 'Synthetic record for cancellation.',
    instructions: 'Share a synthetic report.',
  });
}
function addResult(who: Actor, order: Investigation, note: string, documentIds: string[] = []) {
  return post<Investigation>(who, path(order) + '/results', { note, documentIds });
}
async function reviewResult(
  who: Actor,
  order: Investigation,
  summary: string,
  publishToPatient = false,
) {
  return post<Investigation>(who, path(order) + '/reviews', {
    resultId: order.results.at(-1)!.id,
    summary,
    publishToPatient,
  });
}
async function current(who: Actor, order: Investigation) {
  const workflows = await read<PatientClinicalWorkflows>(
    who,
    '/api/patients/' + order.patientId + '/clinical-workflows',
  );
  return workflows.investigations.find((o) => o.id === order.id)!;
}
async function effects(admin: Actor, patient: Actor, order: Investigation, count: number) {
  const history = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=investigation&entityId=' + order.id,
  );
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  expect(history.items.filter((x) => x.action === 'cancelled investigation')).toHaveLength(count);
  const notices = feed.items.filter(
    (x) => x.title === 'An investigation request was cancelled' && x.detail === order.title,
  );
  expect(notices).toHaveLength(count);
  if (count) expect(notices[0].href).toBe('/my-care/record?tab=workflows');
}
const launch = (page: Page, order: Investigation) =>
  page
    .locator('#investigation-' + order.id)
    .getByRole('button', { name: 'Cancel order', exact: true });
async function draft(page: Page, order: Investigation, text = reason) {
  await launch(page, order).click();
  await expect(title(page, 'Cancel investigation order')).toBeVisible();
  await field(page, reasonLabel).fill(' ' + text + ' ');
}
async function review(page: Page) {
  await button(page, 'Review cancellation').click();
  await expect(title(page, 'Review investigation cancellation')).toBeVisible();
  await expect(checkbox(page)).not.toBeChecked();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, order: Investigation, action: string, status: number) {
  const reply = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint(order) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const response = await reply;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function navigate(page: Page, id: string) {
  await page.evaluate((url) => {
    history.pushState({ key: crypto.randomUUID() }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, chart(id));
}

test('a different linked clinician reviews the latest report and cancels once while the patient retains only shared history', async ({
  page,
  admin,
  patient,
  browser,
}, info) => {
  const order = await createOrder(admin);
  const first = await addResult(patient, order, 'Synthetic initial submission.');
  const privateSummary = 'Synthetic private interpretation.';
  const publicSummary = 'Synthetic shared interpretation.';
  await reviewResult(admin, first, privateSummary);
  await reviewResult(admin, first, publicSummary, true);
  const doc = await post<PatientDocument>(patient, '/api/documents', {
    patientId,
    title: 'Supplemental PDF ' + randomUUID().slice(0, 8),
    originalName: 'synthetic-report.pdf',
    consent: true,
    dataUrl: 'data:application/pdf;base64,' + syntheticPdf().toString('base64'),
  });
  const before = await addResult(patient, order, 'Synthetic supplemental submission.', [doc.id]);
  const latest = before.results.at(-1)!;
  const email = randomUUID() + '@example.test',
    password = randomUUID();
  await post(admin, '/api/users', {
    name: 'Synthetic cancelling clinician',
    email,
    password,
    role: 'doctor',
    doctorId: 'doctor-arjun',
  });
  const signIn = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(signIn.status()).toBe(200);
  const session: Session = await signIn.json();
  await post(
    { api: page.request, session },
    '/api/auth/password',
    { currentPassword: password, newPassword: randomUUID() },
    200,
  );
  await page.goto(chart());
  await draft(page, order);
  await review(page);
  for (const value of [
    order.title,
    'Ananya Sharma',
    order.doctorName,
    'Dr. Arjun Rao',
    latest.note,
    reason,
  ]) {
    await expect(dialog(page)).toContainText(value);
  }
  await expect(
    dialog(page).getByRole('link', { name: 'Linked report · ' + doc.id }),
  ).toHaveAttribute('href', doc.url);
  for (const [label, value] of [
    ['Patient', 'Ananya Sharma · ' + patientId],
    ['Ordering clinician', order.doctorName + ' · ' + order.doctorId],
    ['Cancelling clinician', 'Dr. Arjun Rao · doctor-arjun'],
  ]) {
    await expect(
      dialog(page).getByText(label, { exact: true }).locator('xpath=following-sibling::dd'),
    ).toHaveText(value);
  }
  await mobile(page, save, info.outputPath('review-320.png'));
  const reply = await send(page, order, save, 201);
  const command = reply.request().postDataJSON();
  expect(command).toEqual({
    investigationId: order.id,
    patientId,
    doctorId: 'doctor-arjun',
    cancelledByRole: 'doctor',
    requestId: expect.any(String),
    expectedLatestResultId: latest.id,
    reason,
    reviewedConfirmed: true,
  });
  const { receipt }: InvestigationCancellationResponse = await reply.json();
  expect(receipt).toEqual({
    requestId: command.requestId,
    actorId: session.user!.id,
    investigationId: order.id,
    patientId,
    doctorId: 'doctor-arjun',
    doctorName: 'Dr. Arjun Rao',
    cancelledByRole: 'doctor',
    expectedLatestResultId: latest.id,
    reason,
    title: order.title,
    cancelledAt: expect.any(String),
  });
  await expect(title(page, saved)).toBeVisible();
  await expect(dialog(page)).toContainText(order.id);
  await expect(dialog(page)).toContainText(receipt.doctorName);
  await expect(dialog(page)).toContainText(reason);
  await button(page, 'Done').click();
  const clinic = await current(admin, order),
    portal = await current(patient, order);
  expect(clinic).toEqual({
    ...before,
    status: 'cancelled',
    cancellationReason: reason,
    reviews: expect.any(Array),
  });
  expect(clinic.reviews.map((r) => r.summary)).toEqual([privateSummary, publicSummary]);
  expect(portal).toEqual({ ...clinic, reviews: [clinic.reviews[1]] });
  await effects(admin, patient, order, 1);
  const portalPage = await browser.newPage({ baseURL: info.project.use.baseURL });
  try {
    await login(portalPage.request, 'patient');
    await portalPage.goto('/my-care/record?tab=workflows');
    const card = portalPage
      .locator('.patient-investigation-card')
      .filter({ has: portalPage.getByRole('heading', { name: order.title, exact: true }) });
    for (const value of [reason, latest.note, publicSummary])
      await expect(card).toContainText(value);
    await expect(card.getByRole('link', { name: new RegExp(doc.title) })).toHaveAttribute(
      'href',
      doc.url,
    );
    await expect(card).not.toContainText(privateSummary);
    await expect(card.getByRole('button', { name: /cancel order|share.*result/i })).toHaveCount(0);
  } finally {
    await portalPage.close();
  }
});

test('a lost confirmation recovers the original clinician and reason after malformed replies and a profile rename', async ({
  page,
  admin,
  patient,
}, info) => {
  const who = await login(page.request, 'admin'),
    order = await createOrder(admin);
  const profile = (await read<Doctor[]>(admin, '/api/doctors')).find(
    (d) => d.id === who.session.user!.doctorId,
  )!;
  let original!: InvestigationCancellationResponse;
  const commands: InvestigationCancellationCommand[] = [];
  await page.route('**' + endpoint(order), async (route) => {
    commands.push(route.request().postDataJSON());
    const upstream = await route.fetch();
    const data = await upstream.json();
    expect(upstream.status()).toBe(commands.length === 1 ? 201 : 200);
    if (commands.length === 1) {
      original = data;
      return route.abort('connectionreset');
    }
    if (commands.length === 2) data.receipt.investigationId = randomUUID();
    if (commands.length === 3) data.receipt.actorId = 'another-account';
    if (commands.length === 4) data.receipt.reason = 'Different reason.';
    if (commands.length === 5) data.receipt.expectedLatestResultId = randomUUID();
    return route.fulfill({ response: upstream, json: data });
  });
  await page.goto(chart());
  await draft(page, order);
  await review(page);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  expect(original.receipt.cancelledByRole).toBe('admin');
  expect(original.receipt.expectedLatestResultId).toBeNull();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  await navigate(page, 'patient-2');
  await expect(page.getByRole('heading', { name: 'Rohan Patel', exact: true })).toBeVisible();
  await page.goBack();
  async function rename(name: string) {
    const result = await admin.api.patch('/api/doctors/' + profile.id, {
      headers: { 'X-CSRF-Token': admin.session.csrfToken! },
      data: { ...profile, name },
    });
    expect(result.status(), await result.text()).toBe(200);
  }
  await rename('New synthetic display name');
  try {
    await resume(page, order).click();
    for (let i = 2; i <= 5; i++) {
      await send(page, order, retry, 200);
      await expect(title(page, saved)).toHaveCount(0);
      await expect(button(page, retry)).toBeEnabled();
    }
    expect(await (await send(page, order, retry, 200)).json()).toEqual(original);
    await expect(title(page, saved)).toBeVisible();
    await expect(dialog(page)).toContainText(original.receipt.doctorName);
    await expect(dialog(page)).not.toContainText('New synthetic display name');
    await mobile(page, 'Done', info.outputPath('saved-320.png'));
  } finally {
    await rename(profile.name);
  }
  expect(commands).toHaveLength(6);
  for (const cmd of commands) expect(cmd).toEqual(commands[0]);
  expect((await current(patient, order)).cancellationReason).toBe(reason);
  await effects(admin, patient, order, 1);
});

test('a supplement arriving after review requires a verified refusal and fresh review of that report', async ({
  page,
  admin,
  patient,
}, info) => {
  await login(page.request, 'doctor');
  const order = await createOrder(admin);
  await page.goto(chart());
  await draft(page, order);
  await review(page);
  const oldContext = await read(admin, path(order) + '/review-context');
  const withReport = await addResult(patient, order, 'New synthetic report arrived after review.');
  await page.route(
    '**' + endpoint(order),
    async (route) => {
      const upstream = await route.fetch(),
        data = await upstream.json();
      expect(data.code).toBe('INVESTIGATION_NOT_CANCELLED');
      data.command.investigationId = randomUUID();
      await route.fulfill({ response: upstream, json: data });
    },
    { times: 1 },
  );
  const rejected = await send(page, order, save, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(button(page, refresh)).toHaveCount(0);
  await effects(admin, patient, order, 0);
  const verified = await send(page, order, retry, 409);
  const first: InvestigationCancellationCommand = rejected.request().postDataJSON();
  expect(verified.request().postDataJSON()).toEqual(first);
  expect(first.expectedLatestResultId).toBeNull();
  await expect(title(page, 'Investigation not cancelled')).toBeVisible();
  await mobile(page, refresh, info.outputPath('refused-320.png'));
  await page.route(
    '**' + path(order) + '/review-context',
    (route) => route.fulfill({ status: 200, json: oldContext }),
    { times: 1 },
  );
  await button(page, refresh).click();
  await expect(dialog(page).getByRole('alert')).toContainText(
    'updated investigation could not be verified',
  );
  await expect(button(page, 'Review cancellation')).toHaveCount(0);
  await button(page, 'Try again').click();
  await expect(field(page, reasonLabel)).toHaveValue(' ' + reason + ' ');
  await review(page);
  await expect(dialog(page)).toContainText(withReport.results[0].note);
  const fresh = await send(page, order, save, 201);
  const cmd = fresh.request().postDataJSON();
  expect(cmd).toEqual({
    ...first,
    requestId: expect.any(String),
    expectedLatestResultId: withReport.results[0].id,
  });
  expect(cmd.requestId).not.toBe(first.requestId);
  await expect(title(page, saved)).toBeVisible();
  expect((await current(patient, order)).results).toEqual(withReport.results);
  await effects(admin, patient, order, 1);
});

test('a review or a competing cancellation closes the stale form and preserves the actual outcome', async ({
  page,
  admin,
  patient,
}) => {
  const clinician = await login(page.request, 'doctor');
  for (const concurrent of ['review', 'cancellation']) {
    const order = await createOrder(admin);
    const waiting = await addResult(patient, order, 'Synthetic waiting report.');
    await page.goto(chart());
    await draft(page, order);
    await review(page);
    const otherReason = 'Reason entered by a different clinician.';
    if (concurrent === 'review') await reviewResult(admin, waiting, 'A private competing review.');
    else await post(admin, path(order) + '/cancel', { reason: otherReason }, 200);
    const refused = await send(page, order, save, 409);
    await expect(title(page, 'Investigation not cancelled')).toBeVisible();
    await button(page, refresh).click();
    await expect(title(page, 'Current investigation')).toBeVisible();
    await expect(button(page, save)).toHaveCount(0);
    await expect(field(page, reasonLabel)).toHaveCount(0);
    const stored = await current(patient, order);
    if (concurrent === 'review') {
      expect(stored.status).toBe('reviewed');
      expect(stored.reviews).toEqual([]);
      await addResult(patient, order, 'Another supplement makes this order eligible again.');
      expect(await post(clinician, endpoint(order), refused.request().postDataJSON(), 409)).toEqual(
        await refused.json(),
      );
    } else {
      expect(stored.cancellationReason).toBe(otherReason);
      await expect(dialog(page)).toContainText(otherReason);
    }
    await effects(admin, patient, order, concurrent === 'review' ? 0 : 1);
  }
});

for (const delayed of [
  {
    committed: false,
    title:
      'a delayed unauthorized reply leaves another patient form intact and the undelivered cancellation resumes',
  },
  {
    committed: true,
    title:
      'a delayed success leaves another patient form intact and the committed cancellation can be recovered',
  },
]) {
  test(delayed.title, async ({ page, admin, patient }) => {
    await login(page.request, 'doctor');
    const order = await createOrder(admin),
      other = await createOrder(admin, 'patient-2');
    const seen = deferred(),
      release = deferred();
    let initial!: InvestigationCancellationCommand;
    await page.route(
      '**' + endpoint(order),
      async (route) => {
        initial = route.request().postDataJSON();
        const upstream = delayed.committed ? await route.fetch() : null;
        seen.resolve();
        await release.promise;
        if (upstream) await route.fulfill({ response: upstream });
        else await route.fulfill({ status: 401, json: { error: 'Delayed synthetic reply.' } });
      },
      { times: 1 },
    );
    await page.goto(chart());
    await draft(page, order);
    await review(page);
    await button(page, save).click();
    await seen.promise;
    const late = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === endpoint(order) &&
        r.status() === (delayed.committed ? 201 : 401),
    );
    try {
      await button(page, 'Close for now').click();
      await navigate(page, other.patientId);
      await draft(page, other, 'Different patient draft.');
    } finally {
      release.resolve();
    }
    await (await late).finished();
    await expect(title(page, 'Cancel investigation order')).toBeVisible();
    await expect(field(page, reasonLabel)).toHaveValue(/Different patient draft/);
    await expect(resume(page, order)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goBack();
    await resume(page, order).click();
    expect((await current(patient, order)).status).toBe(
      delayed.committed ? 'cancelled' : 'ordered',
    );
    const response = await send(page, order, retry, delayed.committed ? 200 : 201);
    expect(response.request().postDataJSON()).toEqual(initial);
    await expect(title(page, saved)).toBeVisible();
    expect((await current(admin, other)).status).toBe('ordered');
    await effects(admin, patient, order, 1);
  });
}

test('reload and sign-in discard an unresolved cancellation without persisting the reason or request ID', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const order = await createOrder(admin);
  await page.goto(chart());
  await page.route('**' + endpoint(order), (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic unavailable response.' } }),
  );
  for (const change of ['reload', 'sign-out']) {
    await draft(page, order);
    await review(page);
    const failed = await send(page, order, save, 503);
    await expect(button(page, retry)).toBeEnabled();
    await button(page, 'Close for now').click();
    await expect(resume(page, order)).toBeVisible();
    const persisted = await page.evaluate(() =>
      JSON.stringify([
        window.history.state,
        location.href,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    );
    for (const value of [reason, failed.request().postDataJSON().requestId])
      expect(persisted).not.toContain(value);
    if (change === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await page.getByRole('button', { name: 'Doctor', exact: true }).click();
      await expect(page).toHaveURL('/clinic');
      await navigate(page, patientId);
    }
    await expect(launch(page, order)).toBeVisible();
    await expect(resume(page, order)).toHaveCount(0);
  }
  expect((await current(patient, order)).status).toBe('ordered');
  await effects(admin, patient, order, 0);
});
