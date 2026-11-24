import type { FormEvent, ReactNode } from 'react';
import type { DoctorProfileFields } from '../../shared/doctor-profile-creation';
import { Field } from './ui';

export const profileLabels = {
  name: 'Display name',
  title: 'Professional title',
  qualifications: 'Qualifications',
  experience: 'Years of experience',
  fee: 'Consultation fee (₹)',
  specialties: 'Focus areas',
  languages: 'Languages',
  bio: 'About the doctor',
  color: 'Profile color',
} satisfies Record<keyof DoctorProfileFields, string>;

export function readDoctorProfile(form: HTMLFormElement): DoctorProfileFields {
  const fields = new FormData(form);
  const read = (name: keyof DoctorProfileFields) => String(fields.get(name) ?? '');
  const list = (value: string) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return {
    name: read('name'),
    title: read('title'),
    qualifications: read('qualifications'),
    experience: Number(read('experience')),
    fee: Number(read('fee')),
    specialties: list(read('specialties')),
    languages: list(read('languages')),
    bio: read('bio'),
    color: read('color') || '#e0ede6',
  };
}

export function DoctorProfileForm({
  values,
  creating,
  onSubmit,
  children,
}: {
  values?: DoctorProfileFields;
  creating?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form className="stack" onSubmit={onSubmit}>
      <Field label={profileLabels.name}>
        <input name="name" defaultValue={values?.name} placeholder="Dr. Full name" required />
      </Field>
      <Field label={profileLabels.title}>
        <input name="title" defaultValue={values?.title ?? 'Consultant Dermatologist'} required />
      </Field>
      <Field label={profileLabels.qualifications}>
        <input
          name="qualifications"
          defaultValue={values?.qualifications}
          placeholder="MBBS, MD Dermatology"
          required
        />
      </Field>
      <div className="form-grid">
        <Field label={profileLabels.experience}>
          <input
            type="number"
            name="experience"
            min="0"
            max={creating ? 80 : Math.max(70, values?.experience ?? 0)}
            defaultValue={values?.experience ?? 0}
            required
          />
        </Field>
        <Field label={profileLabels.fee}>
          <input
            type="number"
            name="fee"
            min="0"
            max="100000"
            step={creating || (values && !Number.isInteger(values.fee)) ? 'any' : 1}
            defaultValue={values?.fee ?? 800}
            required
          />
        </Field>
      </div>
      <Field label={profileLabels.specialties} hint="Separate each focus area with a comma.">
        <input
          name="specialties"
          defaultValue={values?.specialties.join(', ')}
          placeholder="Acne, Hair and scalp, General dermatology"
          required
        />
      </Field>
      <Field label={profileLabels.languages} hint="Separate with commas.">
        <input
          name="languages"
          defaultValue={values?.languages.join(', ') ?? 'English, Hindi'}
          required
        />
      </Field>
      <Field label={profileLabels.bio}>
        <textarea
          name="bio"
          defaultValue={values?.bio}
          required={!creating && !!values?.bio}
          maxLength={creating ? 8000 : Math.max(2000, values?.bio.length ?? 0)}
        />
      </Field>
      {creating ? (
        <Field label={profileLabels.color}>
          <input type="color" name="color" defaultValue={values?.color ?? '#e0ede6'} />
        </Field>
      ) : (
        <input type="hidden" name="color" value={values?.color || '#e0ede6'} />
      )}
      {children}
    </form>
  );
}
