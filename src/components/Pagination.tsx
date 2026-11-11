import { ChevronLeft, ChevronRight } from 'lucide-react';
import './pagination.css';

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  disabled = false,
  label = 'Results pagination',
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return (
    <nav className="record-pagination" aria-label={label}>
      <p className="muted small" role="status">
        {start.toLocaleString('en-IN')}–{end.toLocaleString('en-IN')} of{' '}
        {total.toLocaleString('en-IN')} results
      </p>
      <div className="record-pagination-controls">
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(1)}
        >
          First page
        </button>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={15} /> Previous page
        </button>
        <span className="record-pagination-position">
          Page {page.toLocaleString('en-IN')} of {totalPages.toLocaleString('en-IN')}
        </span>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next page <ChevronRight size={15} />
        </button>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(totalPages)}
        >
          Last page
        </button>
      </div>
    </nav>
  );
}
