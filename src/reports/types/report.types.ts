import { Prisma } from '../../../generated/prisma/client';

export const reportSelect = {
  id: true,
  userId: true,
  title: true,
  notes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReportSelect;

export type ReportRecord = Prisma.ReportGetPayload<{
  select: typeof reportSelect;
}>;

export type PaginatedReports = {
  data: ReportRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};
