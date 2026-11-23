import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type { ProcedureCompletion, ProcedureRecord } from '../../shared/clinical';
import type {
  ProcedureCompletionCommand,
  ProcedureCompletionContext,
  ProcedureCompletionResponse,
} from '../../shared/procedure-completion';
import type {
  ProcedureCandidatePage,
  ProcedureScheduleContext,
} from '../../shared/procedure-scheduling';
import type { Appointment } from '../../shared/types';
import {
  type Actor,
  button,
  card,
  checkbox,
  clinic,
  current,
  deferred,
  dialog,
  field,
  login,
  mobile,
  path,
  patientId,
  planFor,
  post,
  read,
  test,
  title,
} from './procedure-fixtures';

const save = 'Save procedure completion';
const retry = 'Retry exact completion';
const resume = 'Resume procedure completion';
const outcomeLabel = 'Procedure outcome and notes';
const aftercareLabel = 'Final aftercare instructions';
const contextPath = (plan: ProcedureRecord) => path(plan) + '/completion-context';
const completionPath = (plan: ProcedureRecord) => path(plan) + '/completions';
const resumeButton = (page: Page) => page.getByRole('button', { name: resume, exact: true });

async function decision(
  patient: Actor,
  plan: ProcedureRecord,
  choice: 'agreed' | 'declined' = 'agreed',
) {
  return post<ProcedureRecord>(patient, path(plan) + '/agreements', {
    decision: choice,
    method: 'portal',
    note: 'Recorded portal choice ' + randomUUID(),
  });
}
async function visitByReason(admin: Actor, tag: string) {
  const visit = (await read<Appointment[]>(admin, '/api/appointments')).find(
    (v) => v.patientId === patientId && v.reason === 'E2E state ' + tag,
  );
  expect(visit, 'Synthetic visit fixture').toBeTruthy();
  return visit!;
}
async function visitLink(admin: Actor, plan: ProcedureRecord, visit: Appointment | null) {
  const route = path(plan) + '/scheduling';
  const source = await read<ProcedureScheduleContext>(admin, route);
  const candidate =
    visit &&
    (
      await read<ProcedureCandidatePage>(
        admin,
        route + '/candidates?from=' + visit.date + '&to=' + visit.date,
      )
    ).items.find((c) => c.appointment.id === visit.id);
  if (visit) expect(candidate).toBeTruthy();
  await post(
    admin,
    route,
    {
      requestId: randomUUID(),
      expectedRevision: source.revision,
      appointmentId: visit?.id ?? null,
      expectedAppointmentRevision: candidate?.revision ?? null,
      reason: 'Synthetic visit link change.',
      ...(visit ? {} : { removeConfirmed: true }),
    },
    200,
  );
}
async function effects(
  admin: Actor,
  patient: Actor,
  plan: ProcedureRecord,
  saved: ProcedureCompletion | null,
) {
  for (const who of [admin, patient]) {
    const entry = await current(who, plan);
    expect(entry.completion).toEqual(saved);
    if (saved) expect(entry.status).toBe('completed');
  }
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=procedure&entityId=' + plan.id,
  );
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  expect(
    audit.items.filter((i) => i.action === 'completed procedure and recorded aftercare'),
  ).toHaveLength(saved ? 1 : 0);
  expect(
    feed.items.filter(
      (i) => i.title === 'Your procedure aftercare is available' && i.detail === plan.title,
    ),
  ).toHaveLength(saved ? 1 : 0);
}
async function open(page: Page, plan: ProcedureRecord) {
  await card(page, plan, 'doctor')
    .getByRole('button', { name: 'Document completion', exact: true })
    .click();
  await expect(title(page, 'Document procedure completion')).toBeVisible();
}
async function draft(page: Page, outcome: string, aftercare: string) {
  await field(page, outcomeLabel).fill(outcome);
  await field(page, aftercareLabel).fill(aftercare);
  await button(page, 'Review completion').click();
  await expect(title(page, 'Confirm procedure completion')).toBeVisible();
  await expect(dialog(page).locator('.procedure-completion-form')).toBeFocused();
  await expect(checkbox(page)).not.toBeChecked();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, plan: ProcedureRecord, action: string, status: number) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === completionPath(plan) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const received = await response;
  expect(received.status()).toBe(status);
  return received;
}

test('a lost completion confirms the original outcome, performing doctor and visit snapshot after the live visit changes', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await login(page.request, 'doctor');
  const visit = await visitByReason(admin, 'already-started');
  const plan = await decision(patient, await planFor(admin, visit.id));
  const source = await read<ProcedureCompletionContext>(doctor, contextPath(plan));
  const outcome = 'Synthetic completed procedure.',
    aftercare = 'Synthetic shared final instructions.';
  await page.goto(clinic);
  await open(page, plan);
  await expect(field(page, aftercareLabel)).toHaveValue(plan.aftercare);
  await draft(page, ' ' + outcome + ' ', ' ' + aftercare + ' ');
  const agreed = plan.agreements.at(-1)!;
  await expect(dialog(page)).toContainText(agreed.note);
  await expect(dialog(page)).toContainText(visit.doctorName);
  await expect(dialog(page)).toContainText(source.doctorName);
  await mobile(page, save, info.outputPath('review-320.png'));
  let original!: ProcedureCompletionResponse;
  const commands: ProcedureCompletionCommand[] = [];
  await page.route('**' + completionPath(plan), async (route) => {
    const n = commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(n === 1 ? 201 : 200);
    const result: ProcedureCompletionResponse = await response.json();
    if (n === 1) {
      original = result;
      return route.abort('connectionreset');
    }
    if (n === 2)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"receipt":' });
    if (n === 3) result.receipt.actorId = admin.session.user!.id;
    if (n === 4) result.receipt.decisionId = randomUUID();
    if (n === 5) result.receipt.completion.aftercare = 'Other instructions.';
    if (n === 6) result.receipt.completion.appointment = null;
    if (n === 7) result.receipt.completion.doctorName = 'Different performing clinician';
    return route.fulfill({ response, json: result });
  });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  const update = await admin.api.patch('/api/appointments/' + visit.id, {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: { status: 'completed' },
  });
  expect(update.status(), await update.text()).toBe(200);
  expect((await current(patient, plan)).scheduledAppointment?.status).toBe('completed');
  await resumeButton(page).click();
  for (let n = 2; n <= 7; n++) {
    await send(page, plan, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, 'Completion recorded')).toHaveCount(0);
  }
  expect(await (await send(page, plan, retry, 200)).json()).toEqual(original);
  expect(commands[0]).toEqual({
    requestId: expect.any(String),
    patientId,
    procedureId: plan.id,
    recordedByRole: 'doctor',
    doctorId: source.doctorId,
    expectedRevision: source.revision,
    expectedDecisionId: agreed.id,
    outcome,
    aftercare,
    reviewedConfirmed: true,
  });
  for (const command of commands) expect(command).toEqual(commands[0]);
  expect(original.receipt).toMatchObject({
    actorId: doctor.session.user!.id,
    decisionId: agreed.id,
    completion: {
      doctorId: source.doctorId,
      doctorName: source.doctorName,
      outcome,
      aftercare,
      appointment: source.procedure.scheduledAppointment,
    },
  });
  await expect(title(page, 'Completion recorded')).toBeVisible();
  await expect(dialog(page)).toContainText(outcome);
  await expect(dialog(page)).toContainText(aftercare);
  await expect(dialog(page)).toContainText(visit.doctorName);
  await mobile(page, 'Done', info.outputPath('saved-320.png'));
  await page.route(
    '**' + contextPath(plan),
    async (route) => {
      const response = await route.fetch(),
        result: ProcedureCompletionContext = await response.json();
      result.procedure.completion!.appointment = result.procedure.scheduledAppointment;
      await route.fulfill({ response, json: result });
    },
    { times: 1 },
  );
  await button(page, 'View current procedure').click();
  await expect(title(page, 'Completion recorded')).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await button(page, 'View current procedure').click();
  await expect(title(page, 'Current procedure')).toBeVisible();
  await expect(dialog(page)).toContainText(aftercare);
  await effects(admin, patient, plan, original.receipt.completion);
});

test('an undelivered completion is submitted once on exact retry and the patient receives the final aftercare', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'admin');
  const plan = await decision(patient, await planFor(admin));
  await page.goto(clinic);
  await open(page, plan);
  await draft(page, 'Recorded synthetic observation.', 'Final instructions for the patient.');
  let first!: ProcedureCompletionCommand;
  await page.route(
    '**' + completionPath(plan),
    (route) => {
      first = route.request().postDataJSON();
      return route.abort('connectionreset');
    },
    { times: 1 },
  );
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await effects(admin, patient, plan, null);
  await resumeButton(page).click();
  const response = await send(page, plan, retry, 201);
  expect(response.request().postDataJSON()).toEqual(first);
  const result: ProcedureCompletionResponse = await response.json();
  expect(result.receipt.completion.appointment).toBe(null);
  expect(result.receipt.actorId).toBe(admin.session.user!.id);
  expect(first.recordedByRole).toBe('admin');
  await expect(title(page, 'Completion recorded')).toBeVisible();
  await button(page, 'Done').click();
  await expect(resumeButton(page)).toHaveCount(0);
  await effects(admin, patient, plan, result.receipt.completion);
});

test('a renewed agreement requires reviewing its new author and discussion before a retained draft can be completed', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await login(page.request, 'doctor'),
    plan = await decision(patient, await planFor(admin));
  const originalContext = await read<ProcedureCompletionContext>(doctor, contextPath(plan));
  const outcome = 'Keep these observations after refreshing the agreement.',
    aftercare = 'Retain this aftercare draft.';
  await page.goto(clinic);
  await open(page, plan);
  await draft(page, outcome, aftercare);
  const cmds: ProcedureCompletionCommand[] = [];
  await page.route('**' + completionPath(plan), async (route) => {
    const n = cmds.push(route.request().postDataJSON());
    if (n === 1) return route.abort('connectionreset');
    const response = await route.fetch(),
      result = await response.json();
    if (n === 2) return route.fulfill({ status: 409, json: { message: 'Ambiguous refusal' } });
    if (n === 3) result.command.aftercare = 'This is a different draft.';
    if (n === 4) delete result.observed;
    return route.fulfill({ response, json: result });
  });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await decision(patient, plan, 'declined');
  const discussion = 'The patient communicated a new agreement by phone.';
  const changed = await post<ProcedureRecord>(admin, path(plan) + '/agreements', {
    decision: 'agreed',
    method: 'phone',
    note: discussion,
    patientDecisionConfirmed: true,
  });
  for (let n = 2; n <= 4; n++) {
    await send(page, plan, retry, 409);
    await expect(button(page, retry)).toBeEnabled();
    await expect(button(page, 'Refresh procedure')).toHaveCount(0);
  }
  const refusal = await (await send(page, plan, retry, 409)).json();
  expect(refusal.observed).toEqual({
    status: 'planned',
    decisionId: changed.agreements.at(-1)!.id,
  });
  await expect(title(page, 'Completion not recorded')).toBeVisible();
  await mobile(page, 'Refresh procedure', info.outputPath('stale-320.png'));
  await effects(admin, patient, plan, null);
  await page.route('**' + contextPath(plan), (route) => route.fulfill({ json: originalContext }), {
    times: 1,
  });
  await button(page, 'Refresh procedure').click();
  await expect(title(page, 'Completion not recorded')).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await button(page, 'Refresh procedure').click();
  await expect(field(page, outcomeLabel)).toHaveValue(outcome);
  await expect(field(page, aftercareLabel)).toHaveValue(aftercare);
  await expect(dialog(page)).toContainText(discussion);
  await draft(page, outcome, aftercare);
  const saved: ProcedureCompletionResponse = await (await send(page, plan, save, 201)).json();
  for (const cmd of cmds.slice(0, 5)) expect(cmd).toEqual(cmds[0]);
  expect(cmds[5].requestId).not.toBe(cmds[0].requestId);
  expect(cmds[5].expectedRevision).not.toBe(cmds[0].expectedRevision);
  expect(cmds[5].expectedDecisionId).toBe(changed.agreements.at(-1)!.id);
  expect(saved.receipt.decisionId).toBe(cmds[5].expectedDecisionId);
  await effects(admin, patient, plan, saved.receipt.completion);
});

test('a newly linked future appointment blocks completion until its association is removed and the draft reviewed again', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const visit = await visitByReason(admin, 'future'),
    plan = await decision(patient, await planFor(admin));
  await page.goto(clinic);
  await open(page, plan);
  const outcome = 'Outcome on an unlinked plan.',
    aftercare = 'Synthetic final instructions.';
  await draft(page, outcome, aftercare);
  await visitLink(admin, plan, visit);
  await send(page, plan, save, 409);
  await expect(title(page, 'Completion not recorded')).toBeVisible();
  await button(page, 'Refresh procedure').click();
  await expect(dialog(page)).toContainText(/future|after the visit starts/i);
  await expect(button(page, save)).toHaveCount(0);
  await expect(button(page, 'Review completion')).toHaveCount(0);
  const procedure = await current(patient, plan);
  expect(procedure.effectiveAppointmentId).toBe(visit.id);
  expect(procedure.status).toBe('planned');
  await effects(admin, patient, plan, null);
  await visitLink(admin, plan, null);
  await button(page, 'Refresh procedure').click();
  await expect(field(page, outcomeLabel)).toHaveValue(outcome);
  await expect(field(page, aftercareLabel)).toHaveValue(aftercare);
  await draft(page, outcome, aftercare);
  const final: ProcedureCompletionResponse = await (await send(page, plan, save, 201)).json();
  expect(final.receipt.completion.appointment).toBe(null);
  expect((await current(patient, plan)).effectiveAppointmentId).toBe(null);
  await effects(admin, patient, plan, final.receipt.completion);
});

test('pending drafts clear on reload and sign-out, and cancellation prevents a subsequent completion', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const plan = await decision(patient, await planFor(admin));
  const attempts: ProcedureCompletionCommand[] = [];
  await page.route(
    '**' + completionPath(plan),
    (route) => {
      attempts.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { message: 'Synthetic unavailable response.' } });
    },
    { times: 2 },
  );
  await page.goto(clinic);
  for (const reset of ['reload', 'sign out']) {
    const note = 'Unsent private outcome ' + randomUUID();
    await open(page, plan);
    await draft(page, note, 'Unsent aftercare.');
    await send(page, plan, save, 503);
    await expect(button(page, retry)).toBeEnabled();
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(storage).not.toContain(note);
    expect(storage).not.toContain(attempts.at(-1)!.requestId);
    await button(page, 'Close for now').click();
    await expect(resumeButton(page)).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await login(page.request, 'doctor');
      await page.goto(clinic);
    }
    await expect(card(page, plan, 'doctor')).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
  }
  expect(attempts[0].requestId).not.toBe(attempts[1].requestId);
  await open(page, plan);
  await expect(field(page, outcomeLabel)).toHaveValue('');
  await draft(page, 'Cannot complete after cancellation.', 'Synthetic aftercare.');
  await post(admin, path(plan) + '/cancel', { reason: 'Planned care cancelled.' }, 200);
  await send(page, plan, save, 409);
  await button(page, 'Refresh procedure').click();
  await expect(dialog(page)).toContainText(/cancelled/i);
  await expect(button(page, 'Review completion')).toHaveCount(0);
  expect((await current(patient, plan)).status).toBe('cancelled');
  await effects(admin, patient, plan, null);
});

test('a late reply from a closed form leaves the second procedure and clinician session intact', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const first = await decision(patient, await planFor(admin)),
    second = await decision(patient, await planFor(admin));
  await page.goto(clinic);
  await open(page, first);
  await draft(page, 'Original outcome before navigation.', 'Aftercare for first procedure.');
  const wrote = deferred(),
    deliver = deferred();
  let original!: ProcedureCompletionResponse;
  await page.route(
    '**' + completionPath(first),
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = await response.json();
      wrote.resolve();
      await deliver.promise;
      await route.fulfill({ status: 401, json: { error: 'Late authorization reply.' } });
    },
    { times: 1 },
  );
  await button(page, save).click();
  await wrote.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === completionPath(first) && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await open(page, second);
    await draft(page, 'Outcome for the second procedure.', 'Aftercare for second procedure.');
  } finally {
    deliver.resolve();
  }
  await (await late).finished();
  const saved: ProcedureCompletionResponse = await (await send(page, second, save, 201)).json();
  await expect(title(page, 'Completion recorded')).toBeVisible();
  await expect(dialog(page)).not.toContainText(original.receipt.completion.outcome);
  await button(page, 'Done').click();
  await resumeButton(page).click();
  await expect(dialog(page)).toContainText(original.receipt.completion.outcome);
  expect(await (await send(page, first, retry, 200)).json()).toEqual(original);
  await effects(admin, patient, first, original.receipt.completion);
  await effects(admin, patient, second, saved.receipt.completion);
});

test('a competing completion stays attributed to the clinician who saved it and a mismatched context is hidden', async ({
  page,
  admin,
  patient,
}) => {
  const doctor = await login(page.request, 'doctor');
  const plan = await decision(patient, await planFor(admin));
  const foreign = 'Synthetic text for another patient.';
  let returnForeignContext = true;
  await page.route('**' + contextPath(plan), async (route) => {
    if (!returnForeignContext) return route.continue();
    const response = await route.fetch();
    const result: ProcedureCompletionContext = await response.json();
    result.procedure.patientId = 'patient-2';
    result.procedure.title = foreign;
    await route.fulfill({ response, json: result });
  });
  await page.goto(clinic);
  await open(page, plan);
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page)).not.toContainText(foreign);
  await expect(field(page, outcomeLabel)).toHaveCount(0);
  returnForeignContext = false;
  await button(page, 'Try again').click();
  const draftOutcome = 'Draft prepared by the doctor.';
  await draft(page, draftOutcome, 'Aftercare draft prepared by the doctor.');
  const source = await read<ProcedureCompletionContext>(admin, contextPath(plan));
  const competing: ProcedureCompletionCommand = {
    requestId: randomUUID(),
    patientId,
    procedureId: plan.id,
    recordedByRole: 'admin',
    doctorId: source.doctorId,
    expectedRevision: source.revision,
    expectedDecisionId: plan.agreements.at(-1)!.id,
    reviewedConfirmed: true,
    outcome: 'Outcome recorded by the administrator with a linked clinical profile.',
    aftercare: 'Final aftercare from the recording clinician.',
  };
  const applied = await post<ProcedureCompletionResponse>(admin, completionPath(plan), competing);
  expect(applied.receipt.actorId).toBe(admin.session.user!.id);
  expect(applied.receipt.actorId).not.toBe(doctor.session.user!.id);
  await send(page, plan, save, 409);
  await expect(title(page, 'Completion not recorded')).toBeVisible();
  await expect(dialog(page)).toContainText(draftOutcome);
  await button(page, 'Refresh procedure').click();
  const recorded = dialog(page)
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: 'Recorded completion', exact: true }),
    });
  const unrecorded = dialog(page).getByRole('region', { name: 'Your unrecorded draft' });
  await expect(unrecorded).toContainText(draftOutcome);
  await expect(unrecorded).not.toContainText(competing.outcome);
  await expect(recorded).toContainText(competing.outcome);
  await expect(recorded).toContainText(competing.aftercare);
  await expect(recorded).not.toContainText(draftOutcome);
  await expect(button(page, 'Review completion')).toHaveCount(0);
  await expect(title(page, 'Completion recorded')).toHaveCount(0);
  await effects(admin, patient, plan, applied.receipt.completion);
});
