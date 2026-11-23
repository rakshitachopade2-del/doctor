import { z } from 'zod';

export const text = z.string().trim().max(8000);
export const short = z.string().trim().max(300);
export const required = short.min(1);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) &&
      new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s,
    'Invalid calendar date',
  );

export const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
