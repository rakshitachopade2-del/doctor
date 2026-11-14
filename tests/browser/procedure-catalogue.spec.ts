import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import type { CareSummary } from '../../shared/care-summary';
import type {
  ProcedureCreateMutation,
  ProcedureTemplateDetail,
  ProcedureTemplateFields,
  ProcedureTemplateMutation,
} from '../../shared/procedure-catalogue';

const labels: Record<keyof ProcedureTemplateFields, string> = {
  title: 'Procedure name',
  benefits: 'Expected benefits',
  risks: 'Risks to discuss',
  alternatives: 'Alternatives to discuss',
  aftercare: 'Planned aftercare instructions',
  estimatedCost: 'Estimated cost',
};
function fields(title: string): ProcedureTemplateFields {
  return {
    title,
    benefits: `Synthetic benefits for ${title}`,
    risks: `Synthetic risks for ${title}`,
    alternatives: 'Synthetic alternative discussion only.',
    aftercare: 'Synthetic aftercare for workflow testing; no treatment advice.',
    estimatedCost: '',
  };
}
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const result = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(result.status(), await result.text()).toBe(200);
  const session = (await result.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const result = await request.get(path);
  expect(result.status(), await result.text()).toBe(200);
  return result.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
  data: unknown,
  status = 200,
): Promise<T> {
  const result = await request.post(path, { headers, data });
  expect(result.status(), await result.text()).toBe(status);
  return result.json();
}
function response(page: Page, path: string) {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
}
async function fillFields(dialog: Locator, value: ProcedureTemplateFields) {
  for (const key of Object.keys(labels) as Array<keyof ProcedureTemplateFields>)
    await dialog.getByLabel(labels[key], { exact: true }).fill(value[key]);
}
async function create(
  request: APIRequestContext,
  headers: Record<string, string>,
  value: ProcedureTemplateFields,
  reason = 'Synthetic internal creation reason',
) {
  return (
    await post<ProcedureTemplateMutation>(
      request,
      headers,
      '/api/procedure-catalogue',
      { fields: value, reason, requestId: randomUUID() },
      201,
    )
  ).detail;
}
async function version(
  request: APIRequestContext,
  headers: Record<string, string>,
  source: ProcedureTemplateDetail,
  value: ProcedureTemplateFields,
  reason = 'Synthetic internal version reason',
) {
  return (
    await post<ProcedureTemplateMutation>(
      request,
      headers,
      `/api/procedure-catalogue/${source.template.id}/versions`,
      {
        fields: value,
        reason,
        expectedRevision: source.template.revision,
        requestId: randomUUID(),
      },
    )
  ).detail;
}
async function publish(
  request: APIRequestContext,
  headers: Record<string, string>,
  source: ProcedureTemplateDetail,
  reason = 'Synthetic internal publication reason',
) {
  return (
    await post<ProcedureTemplateMutation>(
      request,
      headers,
      `/api/procedure-catalogue/${source.template.id}/publish`,
      {
        versionId: source.latestVersion.id,
        reviewed: true,
        reason,
        expectedRevision: source.template.revision,
        requestId: randomUUID(),
      },
    )
  ).detail;
}
async function availability(
  request: APIRequestContext,
  headers: Record<string, string>,
  source: ProcedureTemplateDetail,
  active: boolean,
) {
  return (
    await post<ProcedureTemplateMutation>(
      request,
      headers,
      `/api/procedure-catalogue/${source.template.id}/availability`,
      {
        active,
        reason: 'Synthetic internal availability change',
        expectedRevision: source.template.revision,
        requestId: randomUUID(),
      },
    )
  ).detail;
}
async function publishUI(page: Page, id: string) {
  await page.getByRole('button', { name: 'Make available for plans', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Make this version available for plans',
    exact: true,
  });
  await dialog
    .getByLabel('Publication reason', { exact: true })
    .fill('Internal reviewed publication for synthetic browser test.');
  await dialog
    .getByLabel('I reviewed this version for use in patient-specific procedure plans.', {
      exact: true,
    })
    .check();
  const saved = response(page, `/api/procedure-catalogue/${id}/publish`);
  await dialog.getByRole('button', { name: 'Make available for plans', exact: true }).click();
  const result = await saved;
  expect(result.status(), await result.text()).toBe(200);
  await expect(dialog).toBeHidden();
  return ((await result.json()) as ProcedureTemplateMutation).detail;
}
async function plan(page: Page) {
  await page.goto('/clinic/patients/patient-ananya?tab=workflows');
  await page.getByRole('tab', { name: 'Clinical workup', exact: true }).click();
  await page.getByRole('button', { name: 'Plan procedure', exact: true }).click();
  return page.getByRole('dialog', { name: 'Plan a procedure', exact: true });
}
async function preview(dialog: Locator, title: string) {
  await dialog.getByRole('button', { name: 'Choose a published template', exact: true }).click();
  await dialog.getByLabel('Search procedure templates', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Search templates', exact: true }).click();
  const row = dialog
    .locator('.procedure-template-option')
    .filter({ has: dialog.page().getByRole('heading', { name: title, exact: true }) });
  await row.getByRole('button', { name: 'Preview template', exact: true }).click();
  await expect(dialog.locator('.procedure-template-preview')).toBeVisible();
}
async function savePlan(page: Page, dialog: Locator) {
  const saved = response(page, '/api/procedures');
  await dialog.getByRole('button', { name: 'Save procedure plan', exact: true }).click();
  const result = await saved;
  expect(result.status(), await result.text()).toBe(201);
  await expect(dialog).toBeHidden();
  return result.json() as Promise<ProcedureCreateMutation>;
}
async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const notices = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await notices.count()) await notices.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}

test('published explanations become tailored immutable patient plans while later drafts, publication and archive stay separate', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    marker = randomUUID().slice(0, 8),
    initial = fields(`Catalogue snapshot ${marker}`),
    privateReason = `PRIVATE_CATALOGUE_REASON_${marker}`;
  await page.goto('/clinic/procedure-catalogue');
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Create a procedure template', exact: true });
  await expect(dialog.getByLabel('Indication / reason', { exact: true })).toHaveCount(0);
  await fillFields(dialog, initial);
  await dialog.getByLabel('Reason for this version', { exact: true }).fill(privateReason);
  const creating = response(page, '/api/procedure-catalogue');
  await dialog.getByRole('button', { name: 'Save template draft', exact: true }).click();
  const created = await creating;
  expect(created.status()).toBe(201);
  let source = ((await created.json()) as ProcedureTemplateMutation).detail;
  await expect(dialog).toBeHidden();
  source = await publishUI(page, source.template.id);
  const published = source;
  const newer = {
    ...initial,
    title: `Unpublished explanation ${marker}`,
    risks: `UNPUBLISHED_RISK_${marker}`,
  };
  source = await version(page.request, headers, source, newer, privateReason);
  expect(source.template.selectionRevision).toBe(published.template.selectionRevision);
  dialog = await plan(page);
  await dialog
    .getByLabel('Indication / reason', { exact: true })
    .fill(`Patient-specific indication ${marker}`);
  await dialog.getByLabel('Procedure name', { exact: true }).fill('An unsaved individual draft');
  await preview(dialog, initial.title);
  await expect(dialog.locator('.procedure-template-preview')).toContainText(initial.risks);
  await expect(dialog.locator('.procedure-template-preview')).not.toContainText(newer.risks);
  await expect(dialog.getByRole('button', { name: 'Apply template', exact: true })).toBeDisabled();
  await dialog
    .getByLabel(
      'I understand applying this template replaces the explanation and estimate in my current draft.',
      { exact: true },
    )
    .check();
  await dialog.getByRole('button', { name: 'Apply template', exact: true }).click();
  await expect(dialog.getByLabel('Indication / reason', { exact: true })).toHaveValue(
    `Patient-specific indication ${marker}`,
  );
  await expect(dialog.getByLabel('Estimated cost', { exact: true })).toHaveValue('');
  const customRisk = `Individual discussion ${marker}`;
  await dialog.getByLabel('Risks to discuss', { exact: true }).fill(customRisk);
  await expect(
    dialog.getByRole('button', { name: 'Save procedure plan', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('I reviewed and tailored this plan for this patient.', { exact: true })
    .check();
  const saved = await savePlan(page, dialog);
  expect(saved.procedure.templateSource).toMatchObject({
    version: 1,
    templateTitle: initial.title,
    customizedFields: ['risks'],
  });
  expect(saved.procedure.estimatedCost).toBe('');
  const patient = await browser.newContext({ baseURL }),
    reception = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient@derma.demo');
    const portal = await patient.newPage();
    await portal.goto('/my-care/record?tab=workflows');
    const card = portal
      .locator('.patient-procedure-card')
      .filter({ has: portal.getByRole('heading', { name: initial.title, exact: true }) });
    await expect(card.locator('.procedure-template-source')).toContainText('Version 1');
    await expect(card).toContainText(customRisk);
    await expect(card).not.toContainText(privateReason);
    await card.getByRole('button', { name: 'Review and decide', exact: true }).click();
    const choice = portal.getByRole('dialog', {
      name: 'Review your procedure decision',
      exact: true,
    });
    await choice.getByLabel('Your decision', { exact: true }).selectOption('agreed');
    await choice.getByRole('checkbox').check();
    await choice.getByRole('button', { name: 'Record my decision', exact: true }).click();
    await expect(choice).toBeHidden();
    const summary = await get<CareSummary>(
      patient.request,
      '/api/patients/patient-ananya/care-summary',
    );
    source = await publish(page.request, headers, source, privateReason);
    source = await availability(page.request, headers, source, false);
    const unchanged = await get<CareSummary>(
      patient.request,
      '/api/patients/patient-ananya/care-summary',
    );
    expect(unchanged.revision).toBe(summary.revision);
    expect(unchanged.procedures.find((entry) => entry.id === saved.procedure.id)).toEqual(
      summary.procedures.find((entry) => entry.id === saved.procedure.id),
    );
    expect(JSON.stringify(unchanged)).not.toContain(privateReason);
    expect(JSON.stringify(unchanged)).not.toContain(newer.risks);
    expect(JSON.stringify(unchanged)).not.toContain(saved.receipt.requestId);
    expect((await patient.request.get('/api/procedure-catalogue')).status()).toBe(403);
    await portal.goto('/my-care/summary');
    await expect(portal.locator('#summary-procedures .procedure-template-source')).toContainText(
      initial.title,
    );
    await portal.setViewportSize({ width: 320, height: 900 });
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('procedure-template-patient-summary-mobile.png'),
      fullPage: true,
    });
    await login(reception.request, 'reception@derma.demo');
    expect(
      (await reception.request.get(`/api/procedure-catalogue/${source.template.id}`)).status(),
    ).toBe(403);
    for (const path of [
      '/api/procedure-billing?patientId=patient-ananya',
      '/api/procedure-scheduling?search=' + encodeURIComponent(initial.title),
    ]) {
      const projection = await get<unknown>(reception.request, path);
      expect(JSON.stringify(projection)).not.toContain(customRisk);
      expect(JSON.stringify(projection)).not.toContain(privateReason);
      expect(JSON.stringify(projection)).not.toContain('templateSource');
    }
    await page.goto(`/clinic/procedure-catalogue?template=${source.template.id}`);
    await page.getByRole('button', { name: 'Reactivate template', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Reactivate this template', exact: true });
    await dialog
      .getByLabel('Reactivation reason', { exact: true })
      .fill('Restore the published synthetic catalogue explanation.');
    await dialog.getByRole('button', { name: 'Reactivate template', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Version history', exact: true }).click();
    await page.getByText(`Version 1 · ${initial.title}`, { exact: true }).click();
    await expect(page.locator('.procedure-catalogue-version-history')).toContainText(initial.risks);
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('procedure-catalogue-versions-desktop.png'),
      fullPage: true,
    });
  } finally {
    await patient.close();
    await reception.close();
  }
});

test('catalogue and patient-plan writes preserve stale drafts and confirm exact uncertain requests even after archiving', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    marker = randomUUID().slice(0, 8),
    initial = fields(`Retry explanation ${marker}`);
  let source = await publish(page.request, headers, await create(page.request, headers, initial));
  await page.goto(`/clinic/procedure-catalogue?template=${source.template.id}`);
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Save a new template version', exact: true });
  const retainedRisk = `Retained catalogue draft ${marker}`;
  await dialog.getByLabel('Risks to discuss', { exact: true }).fill(retainedRisk);
  await dialog
    .getByLabel('Reason for this version', { exact: true })
    .fill('Retain my reviewed draft after concurrent version.');
  source = await version(page.request, headers, source, {
    ...initial,
    aftercare: 'Concurrent synthetic aftercare.',
  });
  const path = `/api/procedure-catalogue/${source.template.id}/versions`;
  const stale = response(page, path);
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  expect((await stale).status()).toBe(409);
  await expect(dialog.getByLabel('Risks to discuss', { exact: true })).toHaveValue(retainedRisk);
  await dialog.getByRole('button', { name: 'Refresh latest template', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'I reviewed the latest template; keep my draft', exact: true })
    .click();
  let versionBody: unknown, committedVersion: ProcedureTemplateMutation | undefined;
  const corruptVersion = async (route: Route) => {
    versionBody = route.request().postDataJSON();
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    committedVersion = await result.json();
    await route.fulfill({
      response: result,
      json: {
        ...committedVersion,
        event: { ...committedVersion!.event, createdById: 'different-account' },
      },
    });
  };
  await page.route(`**${path}`, corruptVersion);
  await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Risks to discuss', { exact: true })).toBeDisabled();
  await page.unroute(`**${path}`, corruptVersion);
  const rejectedRetry = async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual(versionBody);
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      json: { error: 'Synthetic retry validation response.' },
    });
  };
  await page.route(`**${path}`, rejectedRetry);
  const rejected = response(page, path);
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await rejected).status()).toBe(400);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Risks to discuss', { exact: true })).toBeDisabled();
  await page.unroute(`**${path}`, rejectedRetry);
  const retried = response(page, path);
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  const retryResult = await retried;
  expect(retryResult.status()).toBe(200);
  expect(retryResult.request().postDataJSON()).toEqual(versionBody);
  expect(((await retryResult.json()) as ProcedureTemplateMutation).event.id).toBe(
    committedVersion!.event.id,
  );
  await expect(dialog).toBeHidden();
  source = await publishUI(page, source.template.id);
  dialog = await plan(page);
  await preview(dialog, initial.title);
  await dialog.getByRole('button', { name: 'Apply template', exact: true }).click();
  const indication = `Retained patient indication ${marker}`,
    risk = `Retained patient-specific risk ${marker}`;
  await dialog.getByLabel('Indication / reason', { exact: true }).fill(indication);
  await dialog.getByLabel('Risks to discuss', { exact: true }).fill(risk);
  await dialog
    .getByLabel('I reviewed and tailored this plan for this patient.', { exact: true })
    .check();
  source = await publish(
    page.request,
    headers,
    await version(page.request, headers, source, {
      ...initial,
      risks: `New source risk ${marker}`,
    }),
  );
  const stalePlan = response(page, '/api/procedures');
  await dialog.getByRole('button', { name: 'Save procedure plan', exact: true }).click();
  expect((await stalePlan).status()).toBe(409);
  await expect(dialog.getByLabel('Indication / reason', { exact: true })).toHaveValue(indication);
  await expect(dialog.getByLabel('Risks to discuss', { exact: true })).toHaveValue(risk);
  await dialog.getByRole('button', { name: 'Refresh template source', exact: true }).click();
  await expect(dialog.locator('.procedure-template-refresh')).toContainText(
    `New source risk ${marker}`,
  );
  await dialog
    .getByRole('button', {
      name: 'I reviewed the latest template; keep my patient-specific draft',
      exact: true,
    })
    .click();
  await expect(
    dialog.getByLabel('I reviewed and tailored this plan for this patient.', { exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByLabel('Risks to discuss', { exact: true })).toHaveValue(risk);
  await dialog
    .getByLabel('I reviewed and tailored this plan for this patient.', { exact: true })
    .check();
  let planBody: unknown, committedPlan: ProcedureCreateMutation | undefined;
  const corruptPlan = async (route: Route) => {
    planBody = route.request().postDataJSON();
    const result = await route.fetch();
    expect(result.status()).toBe(201);
    committedPlan = await result.json();
    await route.fulfill({
      response: result,
      json: {
        ...committedPlan,
        receipt: { ...committedPlan!.receipt, createdById: 'different-account' },
      },
    });
  };
  await page.route('**/api/procedures', corruptPlan);
  await dialog.getByRole('button', { name: 'Save procedure plan', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Indication / reason', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  source = await availability(page.request, headers, source, false);
  await page.unroute('**/api/procedures', corruptPlan);
  const replay = response(page, '/api/procedures');
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  const receipt = await replay;
  expect(receipt.status()).toBe(200);
  expect(receipt.request().postDataJSON()).toEqual(planBody);
  expect(((await receipt.json()) as ProcedureCreateMutation).receipt).toEqual(
    committedPlan!.receipt,
  );
  await expect(dialog).toBeHidden();
  const workflows = await get<PatientClinicalWorkflows>(
    page.request,
    '/api/patients/patient-ananya/clinical-workflows',
  );
  expect(workflows.procedures.filter((entry) => entry.indication === indication)).toHaveLength(1);
  expect(committedPlan!.receipt.createdById).toBe(session.user!.id);
  const current = await get<ProcedureTemplateDetail>(
    page.request,
    `/api/procedure-catalogue/${source.template.id}`,
  );
  expect(current.history.filter((entry) => entry.id === committedVersion!.event.id)).toHaveLength(
    1,
  );
  await page.goto(`/clinic/procedure-catalogue?template=${source.template.id}`);
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Save a new template version', exact: true });
  await dialog
    .getByLabel('Risks to discuss', { exact: true })
    .fill(`Held source response ${marker}`);
  await dialog
    .getByLabel('Reason for this version', { exact: true })
    .fill('Synthetic response after leaving the catalogue.');
  let release!: () => void,
    arrived!: () => void,
    finished!: () => void,
    heldRequestId = '';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const heldVersion = async (route: Route) => {
    heldRequestId = route.request().postDataJSON().requestId;
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    arrived();
    await gate;
    try {
      await route.fulfill({ response: result });
    } finally {
      finished();
    }
  };
  await page.route(`**${path}`, heldVersion);
  try {
    await dialog.getByRole('button', { name: 'Save new version', exact: true }).click();
    await ready;
    await page.evaluate(() => {
      history.pushState({ key: 'catalogue-departure' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await expect(page).toHaveURL('/clinic');
    release();
    await done;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page).toHaveURL('/clinic');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Procedure catalogue updated.', { exact: true })).toHaveCount(0);
    const recorded = await get<ProcedureTemplateDetail>(
      page.request,
      `/api/procedure-catalogue/${source.template.id}`,
    );
    expect(recorded.history.filter((entry) => entry.requestId === heldRequestId)).toHaveLength(1);
  } finally {
    release();
    await page.unroute(`**${path}`, heldVersion);
  }
});

test('bounded template selection, old publication provenance and role-safe manual planning remain accessible on mobile', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const { headers } = await login(page.request, 'doctor@derma.demo'),
    marker = randomUUID().slice(0, 8),
    prefix = `Picker ${marker}`;
  const sources: ProcedureTemplateDetail[] = [];
  for (let i = 0; i < 12; i++)
    sources.push(
      await publish(
        page.request,
        headers,
        await create(page.request, headers, fields(`${prefix} ${String(i).padStart(2, '0')}`)),
      ),
    );
  let source = sources[0];
  for (let i = 0; i < 26; i++)
    source = await version(page.request, headers, source, {
      ...source.latestVersion.fields,
      risks: `Unpublished history ${i} ${marker}`,
    });
  expect(source.historyTotal).toBeGreaterThan(25);
  expect(source.history).toHaveLength(25);
  expect(source.history.some((entry) => entry.id === source.publication!.id)).toBe(false);
  let dialog = await plan(page);
  await dialog.getByRole('button', { name: 'Choose a published template', exact: true }).click();
  await dialog.getByLabel('Search procedure templates', { exact: true }).fill(prefix);
  await dialog.getByRole('button', { name: 'Search templates', exact: true }).click();
  await expect(dialog.locator('.procedure-template-option')).toHaveCount(10);
  const pagination = dialog.getByRole('navigation', {
    name: 'Procedure template pagination',
    exact: true,
  });
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog.locator('.procedure-template-option')).toHaveCount(2);
  await dialog.getByLabel('Search procedure templates', { exact: true }).fill('%');
  await dialog.getByRole('button', { name: 'Search templates', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'No published templates found', exact: true }),
  ).toBeVisible();
  await dialog
    .getByLabel('Search procedure templates', { exact: true })
    .fill(source.publishedVersion!.fields.title);
  await dialog.getByRole('button', { name: 'Search templates', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview template', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply template', exact: true }).click();
  await dialog
    .getByLabel('Indication / reason', { exact: true })
    .fill(`Long-lived source indication ${marker}`);
  await dialog
    .getByLabel('I reviewed and tailored this plan for this patient.', { exact: true })
    .check();
  await page.setViewportSize({ width: 320, height: 900 });
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('procedure-plan-mobile.png'), fullPage: true });
  const saved = await savePlan(page, dialog);
  expect(saved.procedure.templateSource?.reviewedByDoctorId).toBe(source.publication!.doctorId);
  expect(saved.procedure.templateSource?.version).toBe(1);
  dialog = await plan(page);
  const manual = fields(`Manual procedure ${marker}`);
  await fillFields(dialog, manual);
  await dialog
    .getByLabel('Indication / reason', { exact: true })
    .fill('Individual manual indication.');
  const manualSaved = await savePlan(page, dialog);
  expect(manualSaved.procedure.templateSource ?? null).toBeNull();
  expect(manualSaved.receipt.templateSelection).toBeNull();
  await page.goto(`/clinic/procedure-catalogue?template=${source.template.id}`);
  await expect(page.getByRole('button', { name: 'Archive template', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Activity history', exact: true }).click();
  await expect(page.locator('.procedure-catalogue-history .card')).toHaveCount(10);
  await page
    .getByRole('navigation', { name: 'Template activity pagination', exact: true })
    .getByRole('button', { name: 'Last page', exact: true })
    .click();
  await expect(page.locator('.procedure-catalogue-history')).toContainText(
    'Synthetic internal creation reason',
  );
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('procedure-catalogue-history-mobile.png'),
    fullPage: true,
  });
  const admin = await browser.newContext({ baseURL }),
    unlinked = await browser.newContext({ baseURL });
  try {
    const access = await login(admin.request);
    const email = `catalogue-reader-${marker}@example.test`;
    await post(
      admin.request,
      access.headers,
      '/api/users',
      {
        name: 'Unlinked catalogue reader',
        email,
        password: 'InitialCatalogue2026!',
        role: 'admin',
      },
      201,
    );
    const signing = await unlinked.request.post('/api/auth/login', {
      data: { email, password: 'InitialCatalogue2026!' },
    });
    expect(signing.status()).toBe(200);
    const session = (await signing.json()) as Session;
    await post(unlinked.request, { 'X-CSRF-Token': session.csrfToken! }, '/api/auth/password', {
      currentPassword: 'InitialCatalogue2026!',
      newPassword: 'PrivateCatalogue2026!',
    });
    const reader = await unlinked.newPage();
    await reader.goto(`/clinic/procedure-catalogue?template=${source.template.id}`);
    await expect(reader.getByRole('button', { name: 'New version', exact: true })).toHaveCount(0);
    await expect(
      reader.getByRole('button', { name: 'Make available for plans', exact: true }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole('button', { name: 'Archive template', exact: true }),
    ).toBeVisible();
    const current = await get<Session>(unlinked.request, '/api/session');
    const rejected = await unlinked.request.post('/api/procedures', {
      headers: { 'X-CSRF-Token': current.csrfToken! },
      data: {
        ...manual,
        patientId: 'patient-ananya',
        indication: 'Must not write',
        requestId: randomUUID(),
      },
    });
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'Sign in with a linked doctor account to document clinical care.',
    });
  } finally {
    await admin.close();
    await unlinked.close();
  }
});
