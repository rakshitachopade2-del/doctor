import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { reversedPaymentIds } from './billing-corrections.ts';
import type { Appointment, AppointmentStatus, User } from '../shared/types.ts';
import type { Invoice, Payment } from '../shared/operations.ts';
import type { PaymentRefund } from '../shared/billing-corrections.ts';
import {
  expenseCategories,
  type ClinicExpense,
  type ClinicInsights,
  type ExpenseVoid,
  type InsightsDay,
} from '../shared/insights.ts';
import { addDays, clinicToday, get, id, list, nowISO, type DB } from './db.ts';

interface InsightsContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type StoredExpense = Omit<ClinicExpense, 'status' | 'void'>;
const dayMilliseconds = 86_400_000;
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date.',
  );
const dateRange = z.object({ from: dateSchema, to: dateSchema }).superRefine((value, ctx) => {
  const count =
    (Date.parse(`${value.to}T12:00:00Z`) - Date.parse(`${value.from}T12:00:00Z`)) /
      dayMilliseconds +
    1;
  if (count < 1 || count > 366)
    ctx.addIssue({
      code: 'custom',
      message: 'Choose an ordered range of at most 366 days, including both dates.',
      path: ['to'],
    });
});
const appointmentStatuses: AppointmentStatus[] = [
  'scheduled',
  'checked-in',
  'in-consultation',
  'completed',
  'cancelled',
  'no-show',
];
const paymentMethods: Payment['method'][] = ['cash', 'card', 'upi', 'bank'];
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function recordedDate(timestamp: string) {
  return dateFormatter.format(new Date(timestamp));
}

/** Quote every cell and neutralize spreadsheet formula prefixes before CSV encoding. */
export function escapeCsvCell(value: string | number) {
  const text = String(value);
  const safe =
    typeof value === 'string' &&
    (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))
      ? `'${text}`
      : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function registerInsights(app: Express, { db, actor, audit, fail }: InsightsContext) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, incurredDate TEXT NOT NULL, category TEXT NOT NULL,
      requestId TEXT NOT NULL UNIQUE, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expenses_incurred_date ON expenses(incurredDate);
    CREATE TABLE IF NOT EXISTS expenseVoids (
      id TEXT PRIMARY KEY, expenseId TEXT NOT NULL UNIQUE REFERENCES expenses(id), data TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS expense_no_update BEFORE UPDATE ON expenses
      BEGIN SELECT RAISE(ABORT,'Expense records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_no_delete BEFORE DELETE ON expenses
      BEGIN SELECT RAISE(ABORT,'Expense records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_void_no_update BEFORE UPDATE ON expenseVoids
      BEGIN SELECT RAISE(ABORT,'Expense void records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS expense_void_no_delete BEFORE DELETE ON expenseVoids
      BEGIN SELECT RAISE(ABORT,'Expense void records are immutable'); END;
  `);
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function expense(value: StoredExpense): ClinicExpense {
    const row = db.prepare('SELECT data FROM expenseVoids WHERE expenseId=?').get(value.id);
    const voidEvent = row ? (JSON.parse(row.data as string) as ExpenseVoid) : null;
    return { ...value, status: voidEvent ? 'voided' : 'recorded', void: voidEvent };
  }
  function expenses(from: string, to: string) {
    return db
      .prepare(
        'SELECT data FROM expenses WHERE incurredDate>=? AND incurredDate<=? ORDER BY incurredDate DESC,rowid DESC',
      )
      .all(from, to)
      .map((row) => expense(JSON.parse(row.data as string) as StoredExpense));
  }
  const expenseFields = z
    .object({
      incurredDate: dateSchema.refine(
        (value) => value <= clinicToday(),
        'An expense cannot be incurred in the future.',
      ),
      category: z.enum(expenseCategories),
      description: z.string().trim().min(1).max(300),
      amountPaise: z.number().int().min(1).max(1_000_000_000),
      reference: z.string().trim().max(200).default(''),
      requestId: z.string().uuid(),
    })
    .strict();
  app.get('/api/expenses', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const range = dateRange.parse(req.query);
    const filters = z
      .object({
        category: z.enum(expenseCategories).optional(),
        status: z.enum(['recorded', 'voided']).optional(),
      })
      .parse(req.query);
    const entries = transaction(() => {
      const values = expenses(range.from, range.to).filter(
        (value) =>
          (!filters.category || value.category === filters.category) &&
          (!filters.status || value.status === filters.status),
      );
      audit(req, 'viewed clinic expense records', 'expense-report', `${range.from}:${range.to}`);
      return values;
    });
    res.json(entries);
  });
  app.post('/api/expenses', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']);
    const input = expenseFields.parse(req.body);
    const result = transaction(() => {
      const previous = db
        .prepare('SELECT data FROM expenses WHERE requestId=?')
        .get(input.requestId);
      if (previous) {
        const original = JSON.parse(previous.data as string) as StoredExpense;
        if (
          original.incurredDate !== input.incurredDate ||
          original.category !== input.category ||
          original.description !== input.description ||
          original.amountPaise !== input.amountPaise ||
          original.reference !== input.reference
        )
          return fail(
            409,
            'This expense request was already used with different details. Retry the original request or use a new request ID for a separate expense.',
          );
        return { value: expense(original), duplicate: true };
      }
      const value: StoredExpense = {
        ...input,
        id: id(),
        createdById: user.id,
        createdByName: user.name,
        createdAt: nowISO(),
      };
      db.prepare(
        'INSERT INTO expenses(id,incurredDate,category,requestId,data) VALUES (?,?,?,?,?)',
      ).run(value.id, value.incurredDate, value.category, value.requestId, JSON.stringify(value));
      audit(req, 'recorded clinic expense', 'expense', value.id);
      return { value: expense(value), duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result.value);
  });
  app.post('/api/expenses/:id/void', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']);
    const input = z
      .object({ reason: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(req.body);
    const result = transaction(() => {
      const original = get<StoredExpense>(db, 'expenses', String(req.params.id));
      if (!original) return fail(404, 'Expense not found.');
      const current = expense(original);
      if (current.void) {
        if (current.void.reason !== input.reason)
          return fail(
            409,
            'This expense is already voided. Its original void reason cannot be changed.',
          );
        return current;
      }
      const voidEvent: ExpenseVoid = {
        id: id(),
        reason: input.reason,
        voidedById: user.id,
        voidedByName: user.name,
        createdAt: nowISO(),
      };
      db.prepare('INSERT INTO expenseVoids(id,expenseId,data) VALUES (?,?,?)').run(
        voidEvent.id,
        original.id,
        JSON.stringify(voidEvent),
      );
      audit(req, 'voided clinic expense', 'expense', original.id);
      return expense(original);
    });
    res.json(result);
  });

  function addMoney(current: number, amount: number): number {
    const result = current + amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(result) || amount < 0)
      return fail(
        422,
        'A financial total exceeds the supported exact integer range. Narrow the reporting period.',
      );
    return result;
  }
  function aggregate(from: string, to: string): ClinicInsights {
    const days =
      Math.round(
        (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / dayMilliseconds,
      ) + 1;
    const daily: InsightsDay[] = Array.from({ length: days }, (_, offset) => ({
      date: addDays(from, offset),
      appointmentCount: 0,
      completedAppointments: 0,
      cancelledAppointments: 0,
      noShowAppointments: 0,
      invoicedPaise: 0,
      collectionsPaise: 0,
      refundsPaise: 0,
      netCollectionsPaise: 0,
      expensesPaise: 0,
    }));
    const byDay = new Map(daily.map((day) => [day.date, day]));
    const result: ClinicInsights = {
      from,
      to,
      timezone: 'Asia/Kolkata',
      generatedAt: nowISO(),
      totals: {
        appointmentCount: 0,
        patientsWithAppointments: 0,
        invoiceCount: 0,
        invoicedPaise: 0,
        issuedInvoiceOutstandingPaise: 0,
        paymentCount: 0,
        refundCount: 0,
        collectionsPaise: 0,
        refundsPaise: 0,
        netCollectionsPaise: 0,
        expenseCount: 0,
        expensesPaise: 0,
      },
      appointmentsByStatus: appointmentStatuses.map((status) => ({ status, count: 0 })),
      appointmentsByMode: ['in-person', 'online'].map((mode) => ({
        mode: mode as 'in-person' | 'online',
        count: 0,
      })),
      expensesByCategory: expenseCategories.map((category) => ({
        category,
        count: 0,
        amountPaise: 0,
      })),
      collectionsByMethod: paymentMethods.map((method) => ({ method, count: 0, amountPaise: 0 })),
      refundsByMethod: paymentMethods.map((method) => ({ method, count: 0, amountPaise: 0 })),
      daily,
    };
    const patients = new Set<string>();
    for (const appointment of list<Appointment>(db, 'appointments')) {
      const day = byDay.get(appointment.date);
      if (!day) continue;
      patients.add(appointment.patientId);
      result.totals.appointmentCount++;
      day.appointmentCount++;
      result.appointmentsByStatus.find((row) => row.status === appointment.status)!.count++;
      result.appointmentsByMode.find((row) => row.mode === appointment.mode)!.count++;
      if (appointment.status === 'completed') day.completedAppointments++;
      if (appointment.status === 'cancelled') day.cancelledAppointments++;
      if (appointment.status === 'no-show') day.noShowAppointments++;
    }
    result.totals.patientsWithAppointments = patients.size;
    for (const invoice of list<Invoice>(db, 'invoices')) {
      const day = byDay.get(recordedDate(invoice.createdAt));
      if (!day) continue;
      result.totals.invoiceCount++;
      result.totals.invoicedPaise = addMoney(result.totals.invoicedPaise, invoice.totalPaise);
      result.totals.issuedInvoiceOutstandingPaise = addMoney(
        result.totals.issuedInvoiceOutstandingPaise,
        invoice.totalPaise - invoice.paidPaise,
      );
      day.invoicedPaise = addMoney(day.invoicedPaise, invoice.totalPaise);
    }
    const reversed = reversedPaymentIds(db);
    for (const payment of list<Payment>(db, 'payments')) {
      if (reversed.has(payment.id)) continue;
      const day = byDay.get(recordedDate(payment.createdAt));
      if (!day) continue;
      const method = result.collectionsByMethod.find((row) => row.method === payment.method)!;
      result.totals.paymentCount++;
      result.totals.collectionsPaise = addMoney(
        result.totals.collectionsPaise,
        payment.amountPaise,
      );
      day.collectionsPaise = addMoney(day.collectionsPaise, payment.amountPaise);
      method.count++;
      method.amountPaise = addMoney(method.amountPaise, payment.amountPaise);
    }
    // ISO UTC bounds represent inclusive clinic dates without decoding unrelated history.
    const refundFrom = new Date(`${from}T00:00:00.000+05:30`).toISOString();
    const refundTo = new Date(`${to}T23:59:59.999+05:30`).toISOString();
    for (const row of db
      .prepare(
        'SELECT data FROM paymentRefunds WHERE createdAt>=? AND createdAt<=? ORDER BY createdAt,id',
      )
      .all(refundFrom, refundTo)) {
      const refund = JSON.parse(String(row.data)) as PaymentRefund;
      const day = byDay.get(recordedDate(refund.createdAt))!;
      const method = result.refundsByMethod.find((entry) => entry.method === refund.method)!;
      result.totals.refundCount++;
      result.totals.refundsPaise = addMoney(result.totals.refundsPaise, refund.amountPaise);
      day.refundsPaise = addMoney(day.refundsPaise, refund.amountPaise);
      method.count++;
      method.amountPaise = addMoney(method.amountPaise, refund.amountPaise);
    }
    result.totals.netCollectionsPaise = result.totals.collectionsPaise - result.totals.refundsPaise;
    for (const day of daily) day.netCollectionsPaise = day.collectionsPaise - day.refundsPaise;
    for (const entry of expenses(from, to)) {
      if (entry.status === 'voided') continue;
      const day = byDay.get(entry.incurredDate)!;
      const category = result.expensesByCategory.find((row) => row.category === entry.category)!;
      result.totals.expenseCount++;
      result.totals.expensesPaise = addMoney(result.totals.expensesPaise, entry.amountPaise);
      day.expensesPaise = addMoney(day.expensesPaise, entry.amountPaise);
      category.count++;
      category.amountPaise = addMoney(category.amountPaise, entry.amountPaise);
    }
    return result;
  }
  function csv(report: ClinicInsights) {
    type Row = (string | number)[];
    const rows: Row[] = [
      ['section', 'date', 'metric', 'dimension', 'count', 'amountPaise'],
      ['metadata', '', 'from', report.from, '', ''],
      ['metadata', '', 'to', report.to, '', ''],
      ['metadata', '', 'timezone', report.timezone, '', ''],
      ['metadata', '', 'generatedAt', report.generatedAt, '', ''],
      ['metadata', '', 'amountUnit', 'INR paise; 100 paise = INR 1', '', ''],
      [
        'metadata',
        '',
        'appointmentsBasis',
        'Scheduled date; current status; includes cancellations and no-shows',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'invoicesBasis',
        'Current corrected charges; original invoice issue timestamp in Asia/Kolkata',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'collectionsBasis',
        'Original manual payment recording timestamp in Asia/Kolkata; erroneous reversed entries excluded; actual receipt date is not separately stored',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'refundsBasis',
        'Manual refund recording timestamp in Asia/Kolkata; original payment date does not control inclusion; actual transfer date is not separately stored',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'netCollectionsBasis',
        'Period recorded collections less period recorded refunds; may be negative; not profit or bank reconciliation',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'expensesBasis',
        'Incurred date; currently voided expenses excluded',
        '',
        '',
      ],
      [
        'metadata',
        '',
        'outstandingBasis',
        'Current balance of invoices issued in the selected period',
        '',
        '',
      ],
    ];
    for (const [metric, value] of Object.entries(report.totals))
      rows.push([
        'totals',
        '',
        metric,
        '',
        metric.endsWith('Paise') ? '' : value,
        metric.endsWith('Paise') ? value : '',
      ]);
    for (const day of report.daily)
      for (const [metric, value] of Object.entries(day))
        if (metric !== 'date')
          rows.push([
            'daily',
            day.date,
            metric,
            '',
            metric.endsWith('Paise') ? '' : value,
            metric.endsWith('Paise') ? value : '',
          ]);
    for (const row of report.appointmentsByStatus)
      rows.push(['appointmentsByStatus', '', 'appointmentCount', row.status, row.count, '']);
    for (const row of report.appointmentsByMode)
      rows.push(['appointmentsByMode', '', 'appointmentCount', row.mode, row.count, '']);
    for (const row of report.collectionsByMethod)
      rows.push([
        'collectionsByMethod',
        '',
        'recordedCollections',
        row.method,
        row.count,
        row.amountPaise,
      ]);
    for (const row of report.refundsByMethod)
      rows.push(['refundsByMethod', '', 'recordedRefunds', row.method, row.count, row.amountPaise]);
    for (const row of report.expensesByCategory)
      rows.push([
        'expensesByCategory',
        '',
        'incurredExpenses',
        row.category,
        row.count,
        row.amountPaise,
      ]);
    return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
  }
  app.get('/api/insights', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const range = dateRange.parse(req.query);
    const report = transaction(() => {
      const value = aggregate(range.from, range.to);
      audit(
        req,
        'generated aggregate clinic insights',
        'clinic-insights',
        `${range.from}:${range.to}`,
      );
      return value;
    });
    res.json(report);
  });
  app.get('/api/insights/export', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const range = dateRange.parse(req.query);
    const report = transaction(() => {
      const value = csv(aggregate(range.from, range.to));
      audit(
        req,
        'exported aggregate clinic insights',
        'clinic-insights',
        `${range.from}:${range.to}`,
      );
      return value;
    });
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clinic-insights-${range.from}-to-${range.to}.csv"`,
    );
    res.type('text/csv; charset=utf-8').send(report);
  });
}
