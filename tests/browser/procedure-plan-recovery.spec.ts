import { randomUUID } from 'node:crypto';
import { expect, type Page, type Route } from '@playwright/test';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import type { ActivityFeed } from '../../shared/activity';
import type {
  ProcedureCreateMutation,
  ProcedurePlanCommand,
} from '../../shared/procedure-catalogue';
import {
  test,
  read,
  post,
  login,
  field,
  dialog,
  button,
  title,
  mobile,
  deferred,
  type Actor,
} from './workflow-fixtures';

const path = '/api/procedures',
  patientId = 'patient-ananya',
  resume = 'Resume procedure plan',
  retry = 'Retry same request';
const chart = (id = patientId) => '/clinic/patients/' + id + '?tab=workup';
const outside = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function navigate(page: Page, id: string) {
  await page.evaluate((url) => {
    history.pushState({ key: crypto.randomUUID() }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, chart(id));
}
async function enter(page: Page) {
  const who = await login(page.request, 'doctor');
  await page.goto(chart());
  return who;
}
async function fill(page: Page, name: string) {
  await outside(page, 'Plan procedure').click();
  const fields = {
    'Procedure name': name,
    'Indication / reason': 'Synthetic individual indication.',
    'Expected benefits': 'Synthetic benefits.',
    'Risks to discuss': 'Synthetic risk.',
    'Alternatives to discuss': 'Synthetic alternatives.',
    'Planned aftercare instructions': 'Synthetic aftercare.',
    'Estimated cost': 'Synthetic estimate.',
  };
  for (const [label, value] of Object.entries(fields)) await field(page, label).fill(value);
}
const plans = async (who: Actor, id = patientId) =>
  (await read<PatientClinicalWorkflows>(who, '/api/patients/' + id + '/clinical-workflows'))
    .procedures;
async function effects(admin: Actor, patient: Actor, name: string, ids: string[]) {
  expect(
    (await plans(patient))
      .filter((p) => p.title === name)
      .map((p) => p.id)
      .sort(),
  ).toEqual([...ids].sort());
  const notices = (await read<ActivityFeed>(patient, '/api/activity?limit=100')).items.filter(
    (n) => n.title === 'A procedure plan is ready to discuss' && n.detail === name,
  );
  expect(notices).toHaveLength(ids.length);
  for (const id of ids) {
    const audit = await read<{ items: { action: string }[] }>(
      admin,
      '/api/search/audit?entityType=procedure&entityId=' + id,
    );
    expect(
      audit.items.filter(
        (item) => item.action === 'planned procedure and documented discussion information',
      ),
    ).toHaveLength(1);
  }
}

test('a lost plan confirmation survives navigation and later patient decisions; a separately entered identical plan has its own ID', async ({
  page,
  patient,
  admin,
}, info) => {
  const doctor = await enter(page),
    name = 'Synthetic plan ' + randomUUID();
  let saved!: ProcedureCreateMutation, command!: ProcedurePlanCommand;
  await fill(page, name);
  const linkedVisit = field(page, 'Linked appointment');
  await linkedVisit.selectOption({ index: 1 });
  const originalVisit = await linkedVisit.inputValue();
  expect(originalVisit).toBeTruthy();
  await page.route('**' + path, async (route) => {
    command = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    saved = await response.json();
    await route.abort();
  });
  await button(page, 'Save procedure plan').click();
  await expect(button(page, retry)).toBeVisible();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  await navigate(page, 'patient-2');
  await expect(outside(page, 'Plan procedure')).toBeVisible();
  await expect(outside(page, resume)).toHaveCount(0);
  await post(patient, path + '/' + saved.procedure.id + '/agreements', {
    method: 'portal',
    decision: 'agreed',
  });
  await post(
    doctor,
    path + '/' + saved.procedure.id + '/cancel',
    { reason: 'Synthetic closure after the lost reply.' },
    200,
  );
  await navigate(page, patientId);
  await outside(page, resume).click();
  await expect(field(page, 'Procedure name')).toHaveValue(name);
  await page.unroute('**' + path);
  let reply = page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === 'POST',
  );
  await button(page, retry).click();
  const recovered = await reply;
  expect(recovered.status()).toBe(200);
  expect(recovered.request().postDataJSON()).toEqual(command);
  expect(await recovered.json()).toEqual(saved);
  await expect(title(page, 'Procedure plan confirmed')).toBeVisible();
  await expect(dialog(page)).toContainText(originalVisit);
  for (const value of [
    saved.procedure.id,
    'Planned',
    saved.procedure.doctorName,
    name,
    command.indication,
    command.risks,
  ])
    await expect(dialog(page)).toContainText(value);
  await mobile(page, 'Done', info.outputPath('confirmed-320.png'));
  await button(page, 'Done').click();
  const first = (await plans(patient)).find((p) => p.id === saved.procedure.id)!;
  expect(first.status).toBe('cancelled');
  expect(first.agreements).toHaveLength(1);
  await effects(admin, patient, name, [first.id]);
  await fill(page, name);
  await field(page, 'Linked appointment').selectOption(originalVisit);
  reply = page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === 'POST');
  await button(page, 'Save procedure plan').click();
  const second = await reply;
  expect(second.status()).toBe(201);
  const secondId = (await second.json()).procedure.id;
  expect(secondId).not.toBe(first.id);
  await effects(admin, patient, name, [first.id, secondId]);
});

test('a delayed expired-session reply cannot log a clinician out of another patient chart and the original undelivered plan can be saved', async ({
  page,
  admin,
  patient,
}) => {
  await enter(page);
  const name = 'Undelivered ' + randomUUID(),
    arrived = deferred(),
    release = deferred(),
    done = deferred();
  let command!: ProcedurePlanCommand;
  await fill(page, name);
  await page.route('**' + path, async (route) => {
    command = route.request().postDataJSON();
    arrived.resolve();
    await release.promise;
    try {
      await route.fulfill({ status: 401, json: { error: 'Synthetic late reply' } });
    } finally {
      done.resolve();
    }
  });
  await button(page, 'Save procedure plan').click();
  await arrived.promise;
  try {
    await navigate(page, 'patient-2');
    await fill(page, 'Different chart draft');
  } finally {
    release.resolve();
  }
  await done.promise;
  await expect(field(page, 'Procedure name')).toHaveValue('Different chart draft');
  await expect(outside(page, resume)).toHaveCount(0);
  await button(page, 'Cancel').click();
  await navigate(page, patientId);
  await outside(page, resume).click();
  await page.unroute('**' + path);
  const reply = page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === 'POST',
  );
  await button(page, retry).click();
  const res = await reply;
  expect(res.status()).toBe(201);
  expect(res.request().postDataJSON()).toEqual(command);
  const saved: ProcedureCreateMutation = await res.json();
  await button(page, 'Done').click();
  await effects(admin, patient, name, [saved.procedure.id]);
});

test('incorrect original dates, plan state, role and rejection evidence keep the exact request pending', async ({
  page,
  patient,
  admin,
}) => {
  await enter(page);
  const name = 'Mismatched ' + randomUUID();
  await fill(page, name);
  let saved!: ProcedureCreateMutation,
    cmd!: ProcedurePlanCommand,
    step = 0;
  const corrupt = async (route: Route) => {
    const response = await route.fetch();
    saved = await response.json();
    cmd = route.request().postDataJSON();
    const value = structuredClone(saved);
    if (step === 0) value.procedure.status = 'cancelled';
    if (step === 1) {
      value.procedure.createdAt = '2026-01-01';
      value.receipt.createdAt = value.procedure.createdAt;
    }
    if (step === 2) value.receipt.plannedByRole = 'admin';
    if (step++ === 3) {
      await route.fulfill({
        status: 409,
        json: {
          code: 'PROCEDURE_PLAN_NOT_SAVED',
          actorId: saved.receipt.createdById,
          command: { ...cmd, patientId: 'patient-2' },
          field: 'appointment',
          message: 'Wrong case.',
        },
      });
      return;
    }
    await route.fulfill({ response, json: value });
  };
  await page.route('**' + path, corrupt);
  await button(page, 'Save procedure plan').click();
  for (let i = 0; i < 3; i++) {
    await expect(button(page, retry)).toBeEnabled();
    await button(page, retry).click();
  }
  await expect(button(page, retry)).toBeEnabled();
  await expect(field(page, 'Procedure name')).toBeDisabled();
  await page.unroute('**' + path);
  await button(page, retry).click();
  await expect(title(page, 'Procedure plan confirmed')).toBeVisible();
  await button(page, 'Done').click();
  await effects(admin, patient, name, [saved.procedure.id]);
});
test('a reload discards private in-memory plan attempts while retaining a committed plan on the chart', async ({
  page,
  patient,
  admin,
}) => {
  await enter(page);
  const name = 'Tab scoped ' + randomUUID();
  await fill(page, name);
  let saved!: ProcedureCreateMutation;
  await page.route('**' + path, async (route) => {
    const response = await route.fetch();
    saved = await response.json();
    await route.abort();
  });
  await button(page, 'Save procedure plan').click();
  await expect(button(page, retry)).toBeVisible();
  await button(page, 'Close for now').click();
  await expect(outside(page, resume)).toBeVisible();
  const storage = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(storage).not.toContain(name);
  expect(storage).not.toContain(saved.receipt.requestId);
  await page.reload();
  await expect(outside(page, 'Plan procedure')).toBeVisible();
  await expect(outside(page, resume)).toHaveCount(0);
  await effects(admin, patient, name, [saved.procedure.id]);
});
