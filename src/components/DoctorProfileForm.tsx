import { useState, type FormEvent, type ReactNode } from 'react';
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

export function readDoctorProfile(
  form: HTMLFormElement,
  original?: DoctorProfileFields,
): DoctorProfileFields {
  const fields = new FormData(form);
  const read = (name: keyof DoctorProfileFields) => String(fields.get(name) ?? '');
  const readText = (key: 'name' | 'title' | 'qualifications' | 'bio') => {
    const value = read(key);
    // Textareas normalize CR and CRLF in browser values. Preserve untouched stored text.
    return original && value === original[key].replace(/\r\n?/g, '\n') ? original[key] : value;
  };
  const list = (key: 'specialties' | 'languages') =>
    original
      ? fields.getAll(key).map(String)
      : read(key)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
  return {
    name: readText('name'),
    title: readText('title'),
    qualifications: readText('qualifications'),
    experience: Number(read('experience')),
    fee: Number(read('fee')),
    specialties: list('specialties'),
    languages: list('languages'),
    bio: readText('bio'),
    color:
      original && read('color') === original.color.toLowerCase()
        ? original.color
        : read('color') || '#e0ede6',
  };
}

function OrderedProfileList({
  name,
  label,
  values,
}: {
  name: 'specialties' | 'languages';
  label: string;
  values: string[];
}) {
  const [entries, setEntries] = useState(values.map((value, index) => ({ value, key: index })));
  return (
    <fieldset className="stack profile-ordered-list">
      <legend>{profileLabels[name]}</legend>
      {entries.map((entry, index) => (
        <div className="profile-list-entry" key={entry.key}>
          <input type="hidden" name={name} value={entry.value} />
          <Field label={label + ' ' + (index + 1)}>
            <textarea
              rows={1}
              required
              maxLength={300}
              value={entry.value}
              onChange={(event) =>
                setEntries(
                  entries.map((item) =>
                    item.key === entry.key ? { ...item, value: event.target.value } : item,
                  ),
                )
              }
            />
          </Field>
          <button
            type="button"
            className="button button-secondary button-small"
            aria-label={'Remove ' + label.toLowerCase() + ' ' + (index + 1)}
            disabled={entries.length === 1}
            onClick={() => setEntries(entries.filter((item) => item.key !== entry.key))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button-secondary button-small"
        disabled={entries.length >= 20}
        onClick={() =>
          setEntries([
            ...entries,
            { value: '', key: Math.max(...entries.map((item) => item.key)) + 1 },
          ])
        }
      >
        Add {label.toLowerCase()}
      </button>
    </fieldset>
  );
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
        {!creating && values && /[\r\n]/.test(values.name) ? (
          <textarea rows={2} name="name" defaultValue={values.name} required />
        ) : (
          <input name="name" defaultValue={values?.name} placeholder="Dr. Full name" required />
        )}
      </Field>
      <Field label={profileLabels.title}>
        {!creating && values && /[\r\n]/.test(values.title) ? (
          <textarea rows={2} name="title" defaultValue={values.title} required />
        ) : (
          <input name="title" defaultValue={values?.title ?? 'Consultant Dermatologist'} required />
        )}
      </Field>
      <Field label={profileLabels.qualifications}>
        {!creating && values && /[\r\n]/.test(values.qualifications) ? (
          <textarea rows={2} name="qualifications" defaultValue={values.qualifications} required />
        ) : (
          <input
            name="qualifications"
            defaultValue={values?.qualifications}
            placeholder="MBBS, MD Dermatology"
            required
          />
        )}
      </Field>
      <div className="form-grid">
        <Field label={profileLabels.experience}>
          <input
            type="number"
            name="experience"
            min="0"
            max={80}
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
            step="any"
            defaultValue={values?.fee ?? 800}
            required
          />
        </Field>
      </div>
      {!creating && values ? (
        <>
          <OrderedProfileList name="specialties" label="Focus area" values={values.specialties} />
          <OrderedProfileList name="languages" label="Language" values={values.languages} />
        </>
      ) : (
        <>
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
        </>
      )}
      <Field label={profileLabels.bio}>
        <textarea name="bio" defaultValue={values?.bio} maxLength={8000} />
      </Field>
      <Field label={profileLabels.color}>
        <input type="color" name="color" defaultValue={values?.color ?? '#e0ede6'} />
      </Field>

      {children}
    </form>
  );
}
