import type {
  ProcedureCreateMutation,
  ProcedureTemplateDetail,
  ProcedureTemplateFields,
  ProcedureTemplateSelection,
} from '../../shared/procedure-catalogue';

export const procedureFieldNames = [
  'title',
  'benefits',
  'risks',
  'alternatives',
  'aftercare',
  'estimatedCost',
] as const satisfies ReadonlyArray<keyof ProcedureTemplateFields>;
export const procedureFieldLabels: Record<keyof ProcedureTemplateFields, string> = {
  title: 'Procedure name',
  benefits: 'Expected benefits',
  risks: 'Risks to discuss',
  alternatives: 'Alternatives to discuss',
  aftercare: 'Planned aftercare instructions',
  estimatedCost: 'Estimated cost',
};
export type ProcedurePlanDraft = ProcedureTemplateFields & {
  indication: string;
  appointmentId: string;
};
export type ProcedurePlanBody = ProcedureTemplateFields & {
  patientId: string;
  indication: string;
  appointmentId: string | null;
  requestId: string;
  templateSelection?: ProcedureTemplateSelection;
  reviewedForPatient?: true;
};
export type ProcedurePlanAttempt = {
  body: ProcedurePlanBody;
  source: ProcedureTemplateDetail | null;
  actorId: string;
  doctorId: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => text(v) && !!v.trim();
const time = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () =>
  new Error(
    'The saved procedure could not be confirmed. Retry the same request to confirm its outcome.',
  );
export function checkedProcedureCreation(
  value: unknown,
  attempt: ProcedurePlanAttempt,
): ProcedureCreateMutation {
  if (!object(value) || !object(value.procedure) || !object(value.receipt)) throw invalid();
  const p = value.procedure,
    r = value.receipt,
    body = attempt.body;
  if (
    !nonempty(p.id) ||
    p.patientId !== body.patientId ||
    p.appointmentId !== body.appointmentId ||
    p.doctorId !== attempt.doctorId ||
    !nonempty(p.doctorName) ||
    !time(p.createdAt) ||
    [...procedureFieldNames, 'indication'].some(
      (key) => p[key] !== body[key as keyof ProcedurePlanBody],
    ) ||
    !['planned', 'completed', 'cancelled'].includes(p.status as string) ||
    r.requestId !== body.requestId ||
    r.createdById !== attempt.actorId ||
    r.patientId !== body.patientId ||
    r.procedureId !== p.id ||
    r.appointmentId !== body.appointmentId ||
    r.createdAt !== p.createdAt
  )
    throw invalid();
  if (body.templateSelection) {
    const selected = body.templateSelection;
    if (
      !object(r.templateSelection) ||
      r.templateSelection.templateId !== selected.templateId ||
      r.templateSelection.versionId !== selected.versionId ||
      r.templateSelection.expectedSelectionRevision !== selected.expectedSelectionRevision ||
      !object(p.templateSource) ||
      !attempt.source?.publishedVersion
    )
      throw invalid();
    const source = p.templateSource,
      original = attempt.source;
    const publication = original.publication;
    const changed = procedureFieldNames.filter(
      (field) => body[field] !== original.publishedVersion!.fields[field],
    );
    if (
      source.templateId !== selected.templateId ||
      source.versionId !== selected.versionId ||
      source.version !== original.publishedVersion!.version ||
      source.templateTitle !== original.publishedVersion!.fields.title ||
      source.publishedAt !== original.template.publishedAt ||
      !publication ||
      publication.operation !== 'published' ||
      publication.versionId !== selected.versionId ||
      publication.createdAt !== source.publishedAt ||
      source.reviewedByDoctorId !== publication.doctorId ||
      source.reviewedByDoctorName !== publication.doctorName ||
      !equal(source.customizedFields, changed)
    )
      throw invalid();
  } else if (
    r.templateSelection !== null ||
    (p.templateSource !== undefined && p.templateSource !== null)
  )
    throw invalid();
  return value as unknown as ProcedureCreateMutation;
}
export function templateSelection(source: ProcedureTemplateDetail): ProcedureTemplateSelection {
  if (!source.template.active || !source.publishedVersion)
    throw new Error('Choose an active, published procedure template.');
  return {
    templateId: source.template.id,
    versionId: source.publishedVersion.id,
    expectedSelectionRevision: source.template.selectionRevision,
  };
}
export const procedureFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The procedure could not be saved.';
