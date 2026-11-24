import { useState } from 'react';
import type { DoctorProfileFields } from '../../shared/doctor-profile-creation';
import { profileLabels } from './DoctorProfileForm';
import { checkedProfileHistory, differentFields } from './doctor-profile-edit-helpers';
import { useAppointmentBookingData } from './appointment-booking-helpers';
import { Pagination } from './Pagination';
import { Modal, Loading, ErrorState } from './ui';

export function ProfileValue({ value }: { value: DoctorProfileFields[keyof DoctorProfileFields] }) {
  return Array.isArray(value) ? (
    <ol className="profile-value-list">
      {value.map((entry, i) => (
        <li key={i}>{entry}</li>
      ))}
    </ol>
  ) : (
    <>{value === '' ? 'Not provided' : value}</>
  );
}
export function ProfileDifferences({
  before,
  after,
}: {
  before: DoctorProfileFields;
  after: DoctorProfileFields;
}) {
  return (
    <dl className="registration-details">
      {differentFields(before, after).map((field) => (
        <div key={field}>
          <dt>{profileLabels[field]}</dt>
          <dd>
            <span className="muted small">Before</span>
            <div>
              <ProfileValue value={before[field]} />
            </div>
            <span className="muted small">After</span>
            <div>
              <ProfileValue value={after[field]} />
            </div>
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function DoctorProfileHistory({
  doctorId,
  name,
  onClose,
}: {
  doctorId: string;
  name: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const result = useAppointmentBookingData(
    '/api/doctors/' +
      encodeURIComponent(doctorId) +
      '/profile-history?page=' +
      page +
      '&pageSize=10',
    (raw) => checkedProfileHistory(raw, doctorId, page),
  );
  const data = result.data;
  return (
    <Modal title="Doctor profile history" onClose={onClose}>
      <div className="stack doctor-profile-edit">
        <h3>{name}</h3>
        {result.error ? (
          <ErrorState message={result.error} retry={() => void result.reload()} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            {!data.items.length && <p>No profile edits have been recorded.</p>}
            {data.items.map((item) => (
              <article key={item.id} className="stack profile-history-item">
                <strong>{item.actorName}</strong>
                <div className="muted small">
                  {new Date(item.createdAt).toLocaleString('en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'Asia/Kolkata',
                  })}{' '}
                  IST · {item.source === 'reviewed' ? 'Reviewed edit' : 'Compatibility edit'}
                </div>
                <ProfileDifferences before={item.before} after={item.after} />
              </article>
            ))}
            {data.total > 0 && (
              <Pagination {...data} onPageChange={setPage} label="Profile history pagination" />
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
