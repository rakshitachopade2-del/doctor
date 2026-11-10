import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowUpRight, Eye, Plus, Save, Share2, Trash2 } from 'lucide-react';
import type { ClinicalImage } from '../../shared/types';
import type {
  AnnotationColor,
  AnnotationMarker,
  ImageAnnotationHistory,
  ImageAnnotationVersion,
} from '../../shared/image-annotations';
import { api, ApiError, formatDate, useResource, useSession, useToast } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import './image-annotations.css';

const colors: Record<AnnotationColor, string> = {
  red: '#dc3434',
  amber: '#f4b739',
  green: '#34b56e',
  blue: '#3d8cf0',
  purple: '#bb70ee',
  white: '#ffffff',
};
const percent = (value: number) => Number((value * 100).toFixed(4));
const stamp = (value: string) =>
  `${formatDate(value)} · ${new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`;
const problemText = (problem: unknown) =>
  problem instanceof Error ? problem.message : 'The request could not be completed.';
function geometry(marker: AnnotationMarker) {
  return marker.type === 'arrow'
    ? `Start ${percent(marker.x1)}% across, ${percent(marker.y1)}% down; end ${percent(marker.x2)}% across, ${percent(marker.y2)}% down.`
    : `Left ${percent(marker.x)}%, top ${percent(marker.y)}%, width ${percent(marker.width)}%, height ${percent(marker.height)}%.`;
}

/** The SVG shares the exact rendered image bounds; no cropped or letterboxed coordinates. */
export function ImageAnnotationOverlay({
  image,
  markers,
  showMarkers = true,
  onReady,
}: {
  image: ClinicalImage;
  markers: AnnotationMarker[];
  showMarkers?: boolean;
  onReady?: (ready: boolean) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const arrowId = useId().replace(/:/g, '');
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [image.url]);
  return (
    <div className="ia-image-frame">
      <div className="ia-image-plane">
        <img
          src={image.url}
          alt={image.caption || 'Clinical image'}
          onLoad={() => {
            setLoaded(true);
            onReady?.(true);
          }}
          onError={() => {
            setFailed(true);
            onReady?.(false);
          }}
        />
        {loaded && showMarkers && (
          <svg
            className="ia-overlay"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              {Object.entries(colors).map(([name, color]) => (
                <marker
                  key={name}
                  id={`${arrowId}-${name}`}
                  markerWidth="9"
                  markerHeight="9"
                  refX="7"
                  refY="4"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L8,4 L0,8" fill={color} stroke="#182820" strokeWidth="0.5" />
                </marker>
              ))}
            </defs>
            {markers.map((mark, index) => {
              const x = (mark.type === 'arrow' ? mark.x1 : mark.x) * 1000;
              const y = (mark.type === 'arrow' ? mark.y1 : mark.y) * 1000;
              const shape = (stroke: string, width: number) => {
                const common = {
                  fill: 'none',
                  stroke,
                  strokeWidth: width,
                  vectorEffect: 'non-scaling-stroke' as const,
                };
                if (mark.type === 'rectangle')
                  return (
                    <rect
                      {...common}
                      x={x}
                      y={y}
                      width={mark.width * 1000}
                      height={mark.height * 1000}
                    />
                  );
                if (mark.type === 'ellipse')
                  return (
                    <ellipse
                      {...common}
                      cx={x + mark.width * 500}
                      cy={y + mark.height * 500}
                      rx={mark.width * 500}
                      ry={mark.height * 500}
                    />
                  );
                return mark.type === 'arrow' ? (
                  <line
                    {...common}
                    x1={x}
                    y1={y}
                    x2={mark.x2 * 1000}
                    y2={mark.y2 * 1000}
                    markerEnd={width === 2.5 ? `url(#${arrowId}-${mark.color})` : undefined}
                  />
                ) : null;
              };
              return (
                <g key={mark.id}>
                  {shape('#17261f', 5)}
                  {shape(colors[mark.color], 2.5)}
                  <rect
                    x={Math.min(x, 944)}
                    y={Math.min(y, 952)}
                    width="56"
                    height="48"
                    rx="8"
                    fill="#17261f"
                  />
                  <text
                    x={Math.min(x, 944) + 28}
                    y={Math.min(y, 952) + 34}
                    fill="white"
                    textAnchor="middle"
                    fontSize="34"
                    fontFamily="sans-serif"
                  >
                    {index + 1}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {failed && (
        <p className="notice notice-error" role="alert">
          The original image could not be loaded. Reopen this viewer to try again.
        </p>
      )}
    </div>
  );
}

function MarkDescriptions({ markers }: { markers: AnnotationMarker[] }) {
  return markers.length ? (
    <ol className="ia-mark-descriptions">
      {markers.map((mark, index) => (
        <li key={mark.id}>
          <strong>
            Mark {index + 1} · {mark.type}
          </strong>
          <p>{mark.label || 'No mark note recorded.'}</p>
          <span>{geometry(mark)}</span>
        </li>
      ))}
    </ol>
  ) : (
    <p className="muted small">No shapes in this revision.</p>
  );
}

function RevisionDetails({ version }: { version: ImageAnnotationVersion }) {
  return (
    <div className="ia-revision-details">
      <div className="ia-version-meta">
        <Badge tone={version.publishedAt ? 'green' : 'neutral'}>
          {version.publishedAt ? 'Shared with patient' : 'Clinic only'}
        </Badge>
        <span>
          Recorded by {version.doctorName} · {stamp(version.createdAt)}
        </span>
      </div>
      {version.publishedAt && (
        <p className="muted small">
          Shared by {version.publishedByDoctorName} · {stamp(version.publishedAt)}
        </p>
      )}
      <h3>Clinician note</h3>
      <p className="ia-note">{version.note || 'No overall note recorded.'}</p>
      <h3>Image marks</h3>
      <MarkDescriptions markers={version.markers} />
    </div>
  );
}

/** Uses the server's patient-safe history: no count or metadata about private revisions. */
export function ImageAnnotationViewer({
  image,
  enabled = true,
}: {
  image: ClinicalImage;
  enabled?: boolean;
}) {
  const history = useResource<ImageAnnotationHistory>(`/api/images/${image.id}/annotations`);
  const [selectedId, setSelectedId] = useState('');
  const [showMarkers, setShowMarkers] = useState(true);
  const selected =
    history.data?.versions.find((version) => version.id === selectedId) ??
    history.data?.versions[0];
  return (
    <div className="ia-viewer">
      <p className="muted">{image.caption}</p>
      <a
        className="button button-secondary button-small"
        href={image.url}
        target="_blank"
        rel="noreferrer"
      >
        Open original image <ArrowUpRight size={15} />
      </a>
      {!enabled && (
        <p className="notice">
          New image documentation is paused. Shared history remains available.
        </p>
      )}
      {history.loading ? (
        <Loading />
      ) : history.error ? (
        <ErrorState message={history.error} retry={history.reload} />
      ) : (
        <>
          {!!history.data?.versions.length && (
            <Field label="Shared annotation version">
              <select
                value={selected?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {history.data.versions.map((version, index) => (
                  <option key={version.id} value={version.id}>
                    Shared version {history.data!.versions.length - index} ·{' '}
                    {stamp(version.createdAt)} · {version.doctorName}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {selected && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={showMarkers}
                onChange={(event) => setShowMarkers(event.target.checked)}
              />
              Show clinician marks
            </label>
          )}
          <ImageAnnotationOverlay
            image={image}
            markers={selected?.markers ?? []}
            showMarkers={showMarkers}
          />
          {selected ? (
            <RevisionDetails version={selected} />
          ) : (
            <EmptyState
              title="No image annotations shared yet"
              description="Your original image remains available. Clinician annotations appear here when shared with you."
            />
          )}
          <p className="ia-help">
            Marks identify areas discussed by your clinician. Percentages describe position within
            the photograph, not physical measurements.
          </p>
        </>
      )}
    </div>
  );
}

export function ImageAnnotationModal({
  image,
  enabled,
  onClose,
}: {
  image: ClinicalImage;
  enabled: boolean;
  onClose: () => void;
}) {
  const { session } = useSession();
  const canWrite = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  const toast = useToast();
  const [history, setHistory] = useState<ImageAnnotationHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [markers, setMarkers] = useState<AnnotationMarker[]>([]);
  const [activeMark, setActiveMark] = useState('');
  const [expectedRevision, setExpectedRevision] = useState<string | null>(null);
  const [initialDraft, setInitialDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [discard, setDiscard] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareConfirmed, setShareConfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [freshHistory, setFreshHistory] = useState<ImageAnnotationHistory | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const path = `/api/images/${image.id}/annotations`;
  async function loadHistory() {
    setLoading(true);
    setLoadError('');
    try {
      setHistory(await api<ImageAnnotationHistory>(path));
    } catch (problem) {
      setLoadError(problemText(problem));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let current = true;
    api<ImageAnnotationHistory>(path)
      .then((value) => {
        if (current) setHistory(value);
      })
      .catch((problem) => {
        if (current) setLoadError(problemText(problem));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [path]);
  const selected =
    history?.versions.find((version) => version.id === selectedId) ?? history?.versions[0];
  const currentMark = markers.find((mark) => mark.id === activeMark);
  const dirty = editing && JSON.stringify({ note, markers }) !== initialDraft;
  function close() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  function beginEdit() {
    const nextMarkers = selected?.markers.map((mark) => ({ ...mark })) ?? [];
    const nextNote = selected?.note ?? '';
    setMarkers(nextMarkers);
    setNote(nextNote);
    setActiveMark(nextMarkers[0]?.id ?? '');
    setInitialDraft(JSON.stringify({ note: nextNote, markers: nextMarkers }));
    setExpectedRevision(history?.revision ?? null);
    setEditing(true);
    setError('');
    setConflict(false);
    setFreshHistory(null);
    setShowMarkers(true);
    setSharing(false);
  }
  function addMark(type: AnnotationMarker['type']) {
    if (busy || markers.length >= 50) return;
    const common = { id: crypto.randomUUID(), color: 'red' as const, label: '' };
    const mark: AnnotationMarker =
      type === 'arrow'
        ? { ...common, type, x1: 0.25, y1: 0.25, x2: 0.65, y2: 0.65 }
        : { ...common, type, x: 0.25, y: 0.25, width: 0.3, height: 0.3 };
    setMarkers((previous) => [...previous, mark]);
    setActiveMark(mark.id);
    setShowMarkers(true);
    setAnnouncement(
      `${type} mark ${markers.length + 1} added. Position controls are below the mark list.`,
    );
  }
  function updateMark(value: Partial<AnnotationMarker>) {
    setMarkers((previous) =>
      previous.map((mark) =>
        mark.id === activeMark ? ({ ...mark, ...value } as AnnotationMarker) : mark,
      ),
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !enabled || !canWrite || conflict || !imageReady) return;
    if (!note.trim() && !markers.length)
      return setError('Add a clinician note or at least one mark.');
    for (const mark of markers) {
      const coordinates =
        mark.type === 'arrow'
          ? [mark.x1, mark.y1, mark.x2, mark.y2]
          : [mark.x, mark.y, mark.width, mark.height];
      if (coordinates.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
        return setError('Use positions between 0% and 100% for every mark.');
      if (
        mark.type !== 'arrow' &&
        (mark.width <= 0 ||
          mark.height <= 0 ||
          mark.x + mark.width > 1.0000001 ||
          mark.y + mark.height > 1.0000001)
      )
        return setError(
          'Keep every shape inside the image. Left plus width and top plus height must each be 100% or less.',
        );
      if (mark.type === 'arrow' && mark.x1 === mark.x2 && mark.y1 === mark.y2)
        return setError('An arrow must have different start and end points.');
    }
    setBusy(true);
    setError('');
    try {
      const saved = await api<ImageAnnotationHistory>(path, {
        method: 'POST',
        body: { expectedRevision, note: note.trim(), markers },
      });
      setHistory(saved);
      setSelectedId(saved.versions[0]?.id ?? '');
      setEditing(false);
      setDiscard(false);
      setConflict(false);
      toast('Private annotation revision saved.');
    } catch (problem) {
      setError(problemText(problem));
      if (!(problem instanceof ApiError) || ![400, 403, 422].includes(problem.status)) {
        setConflict(true);
        setFreshHistory(null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function fetchLatest() {
    if (busy) return;
    setBusy(true);
    try {
      const latest = await api<ImageAnnotationHistory>(path);
      setFreshHistory(latest);
      setHistory(latest);
      setError('');
    } catch (problem) {
      setError(problemText(problem));
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (
      busy ||
      !shareConfirmed ||
      !selected ||
      !enabled ||
      !canWrite ||
      selected.id !== history?.versions[0]?.id
    )
      return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<ImageAnnotationHistory>(`${path}/${selected.id}/publish`, {
        method: 'POST',
        body: { expectedRevision: history.revision, patientSharingConfirmed: true },
      });
      setHistory(saved);
      setSharing(false);
      setShareConfirmed(false);
      toast('This annotation revision is now shared with the patient.');
    } catch (problem) {
      setError(problemText(problem));
      if (problem instanceof ApiError && problem.status === 409) {
        setSharing(false);
        setShareConfirmed(false);
        await loadHistory();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Image annotations" onClose={close}>
      <div className="ia-workspace">
        <div className="ia-heading">
          <div>
            <h3>{image.caption}</h3>
            <p className="ia-help">
              Original pixels remain unchanged. New revisions are private until explicitly shared
              with this patient.
            </p>
          </div>
          <a
            className="button button-secondary button-small"
            href={image.url}
            target="_blank"
            rel="noreferrer"
          >
            Open original <ArrowUpRight size={15} />
          </a>
        </div>
        {!enabled && (
          <p className="notice">
            Image documentation is paused. Saved annotations remain readable; saving and sharing are
            unavailable.
          </p>
        )}
        {!canWrite && (
          <p className="notice">
            A linked clinician account is required to save or share annotations.
          </p>
        )}
        {discard && (
          <div className="notice ia-discard" role="alert">
            <strong>Discard your unsaved annotation draft?</strong>
            <div className="row">
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setDiscard(false)}
              >
                Keep editing
              </button>
              <button
                className="button button-danger"
                disabled={busy}
                onClick={() => {
                  if (!busy) onClose();
                }}
              >
                Discard draft and close
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <Loading />
        ) : loadError ? (
          <ErrorState message={loadError} retry={loadHistory} />
        ) : (
          <>
            {!editing && (
              <div className="ia-history-toolbar">
                {!!history?.versions.length && (
                  <Field label="Saved annotation revision">
                    <select
                      value={selected?.id ?? ''}
                      disabled={busy}
                      onChange={(event) => {
                        setSelectedId(event.target.value);
                        setSharing(false);
                        setShareConfirmed(false);
                        setError('');
                      }}
                    >
                      {history.versions.map((version, index) => (
                        <option key={version.id} value={version.id}>
                          Revision {history.versions.length - index} ·{' '}
                          {version.publishedAt ? 'Shared' : 'Clinic only'} ·{' '}
                          {stamp(version.createdAt)} · {version.doctorName}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <button
                  className="button button-primary"
                  disabled={!enabled || !canWrite || busy}
                  onClick={beginEdit}
                >
                  <Plus size={16} />
                  {selected ? 'Create new revision' : 'Add annotations'}
                </button>
              </div>
            )}
            <div className="ia-layout">
              <div className="ia-preview">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={showMarkers}
                    onChange={(event) => setShowMarkers(event.target.checked)}
                  />
                  Show marks on image
                </label>
                <ImageAnnotationOverlay
                  image={image}
                  markers={editing ? markers : (selected?.markers ?? [])}
                  showMarkers={showMarkers}
                  onReady={setImageReady}
                />
                <p className="ia-help">
                  Percentages describe image position, not physical size. Marks and notes are
                  entered by a clinician; no diagnosis is generated.
                </p>
              </div>
              <div className="ia-controls">
                {editing ? (
                  <form className="stack" onSubmit={save}>
                    <div>
                      <Badge>Unsaved private draft</Badge>
                      <p className="ia-help">
                        Saving adds a revision and preserves every earlier version.
                      </p>
                    </div>
                    <Field label="Clinician annotation note">
                      <textarea
                        maxLength={4000}
                        rows={4}
                        disabled={busy}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </Field>
                    <fieldset className="ia-fieldset" disabled={busy}>
                      <legend>Add an image mark</legend>
                      <div className="ia-shape-buttons">
                        {(['rectangle', 'ellipse', 'arrow'] as const).map((type) => (
                          <button
                            key={type}
                            className="button button-secondary button-small"
                            type="button"
                            disabled={markers.length >= 50}
                            onClick={() => addMark(type)}
                          >
                            Add {type}
                          </button>
                        ))}
                      </div>
                      <p className="ia-help">
                        {markers.length}/50 marks. Add a shape, select it below, then adjust its
                        position.
                      </p>
                    </fieldset>
                    <div role="status" className="sr-only">
                      {announcement}
                    </div>
                    {!!markers.length && (
                      <Field label="Selected mark">
                        <select
                          disabled={busy}
                          value={activeMark}
                          onChange={(event) => setActiveMark(event.target.value)}
                        >
                          {markers.map((mark, index) => (
                            <option value={mark.id} key={mark.id}>
                              Mark {index + 1} · {mark.type}
                              {mark.label ? ` · ${mark.label}` : ''}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {currentMark && (
                      <fieldset className="ia-fieldset ia-position-controls" disabled={busy}>
                        <legend>
                          Mark {markers.findIndex((mark) => mark.id === activeMark) + 1} ·{' '}
                          {currentMark.type}
                        </legend>
                        <Field label="Mark note">
                          <textarea
                            rows={2}
                            maxLength={200}
                            value={currentMark.label}
                            onChange={(event) => updateMark({ label: event.target.value })}
                          />
                        </Field>
                        <Field label="Mark color">
                          <select
                            value={currentMark.color}
                            onChange={(event) =>
                              updateMark({ color: event.target.value as AnnotationColor })
                            }
                          >
                            {Object.keys(colors).map((color) => (
                              <option key={color} value={color}>
                                {color}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <div className="ia-coordinates">
                          {(currentMark.type === 'arrow'
                            ? [
                                { key: 'x1', label: 'Start across (%)' },
                                { key: 'y1', label: 'Start down (%)' },
                                { key: 'x2', label: 'End across (%)' },
                                { key: 'y2', label: 'End down (%)' },
                              ]
                            : [
                                { key: 'x', label: 'Left (%)' },
                                { key: 'y', label: 'Top (%)' },
                                { key: 'width', label: 'Width (%)' },
                                { key: 'height', label: 'Height (%)' },
                              ]
                          ).map(({ key, label }) => (
                            <Field key={`${currentMark.id}:${key}`} label={label}>
                              <input
                                type="number"
                                required
                                min={key === 'width' || key === 'height' ? 0.0001 : 0}
                                max={100}
                                step="any"
                                value={percent(
                                  (currentMark as unknown as Record<string, number>)[key],
                                )}
                                onChange={(event) =>
                                  updateMark({ [key]: Number(event.target.value) / 100 })
                                }
                              />
                            </Field>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="button button-ghost button-small"
                          onClick={() => {
                            const remaining = markers.filter((mark) => mark.id !== activeMark);
                            setMarkers(remaining);
                            setActiveMark(remaining[0]?.id ?? '');
                            setAnnouncement('Selected mark removed from this unsaved draft.');
                          }}
                        >
                          <Trash2 size={15} />
                          Remove selected mark
                        </button>
                      </fieldset>
                    )}
                    {conflict && (
                      <div className="notice ia-conflict" role="alert">
                        <strong>Check the latest history before saving again.</strong>
                        <p>
                          Your local draft is preserved. Another revision may have been saved or
                          shared.
                        </p>
                        {freshHistory ? (
                          <>
                            <p>
                              Latest saved note:{' '}
                              {freshHistory.versions[0]?.note || 'No overall note.'}
                            </p>
                            {freshHistory.versions[0] && (
                              <details>
                                <summary>Review latest saved marks</summary>
                                <MarkDescriptions markers={freshHistory.versions[0].markers} />
                              </details>
                            )}
                            <button
                              type="button"
                              className="button button-secondary"
                              disabled={busy}
                              onClick={() => {
                                setExpectedRevision(freshHistory.revision);
                                setConflict(false);
                                setFreshHistory(null);
                                setError('');
                              }}
                            >
                              I reviewed the latest history; keep my draft
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={busy}
                            onClick={fetchLatest}
                          >
                            Load latest history and keep draft
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      className="button button-primary"
                      disabled={busy || !enabled || !canWrite || conflict || !imageReady}
                    >
                      <Save size={16} />
                      {busy ? 'Saving…' : 'Save private revision'}
                    </button>
                  </form>
                ) : selected ? (
                  <>
                    <RevisionDetails version={selected} />
                    {selected.id === history?.versions[0]?.id && !selected.publishedAt && (
                      <div className="ia-share">
                        {sharing ? (
                          <>
                            <h3>Share this saved revision</h3>
                            <p className="ia-help">
                              The patient will see this revision’s marks, note and clinician
                              attribution. Sharing does not make the image public and cannot be
                              undone here.
                            </p>
                            <label className="checkbox-field">
                              <input
                                type="checkbox"
                                disabled={busy}
                                checked={shareConfirmed}
                                onChange={(event) => setShareConfirmed(event.target.checked)}
                              />
                              I have reviewed this revision and want to share it with this patient.
                            </label>
                            <div className="row">
                              <button
                                className="button button-primary"
                                disabled={busy || !shareConfirmed || !enabled}
                                onClick={publish}
                              >
                                {busy ? 'Sharing…' : 'Confirm patient sharing'}
                              </button>
                              <button
                                className="button button-ghost"
                                disabled={busy}
                                onClick={() => {
                                  setSharing(false);
                                  setShareConfirmed(false);
                                }}
                              >
                                Cancel sharing
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            className="button button-secondary"
                            disabled={!enabled || !canWrite || busy}
                            onClick={() => setSharing(true)}
                          >
                            <Share2 size={16} />
                            Share revision with patient
                          </button>
                        )}
                      </div>
                    )}
                    {selected.id !== history?.versions[0]?.id && !selected.publishedAt && (
                      <p className="ia-help">
                        Only the latest saved revision can be shared. This earlier private revision
                        remains in the clinical history.
                      </p>
                    )}
                  </>
                ) : (
                  <EmptyState
                    title="No annotations recorded"
                    description="Add shapes or a note to document areas discussed during care. Each save creates a private revision."
                  />
                )}
              </div>
            </div>
            <div className="ia-footer">
              <span className="muted small">
                <Eye size={14} /> Original image retained · {formatDate(image.createdAt)}
              </span>
              <button className="button button-secondary" disabled={busy} onClick={close}>
                {editing ? 'Close editor' : 'Close annotations'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
