import type { ProcedureTemplateSource as Source } from '../../shared/procedure-catalogue';
import { formatDate } from '../lib';
import './procedure-plan.css';

/** Only immutable patient-safe attribution belongs here; never fetch the live catalogue. */
export function ProcedureTemplateSource({ source }: { source?: Source | null }) {
  if (!source) return null;
  return (
    <div className="procedure-template-source">
      <strong>Based on a clinic template</strong>
      <p>
        {source.templateTitle} · Version {source.version}
      </p>
      <p>
        Published by {source.reviewedByDoctorName} on {formatDate(source.publishedAt)}. Your
        clinician recorded the patient-specific plan shown here.
      </p>
    </div>
  );
}
