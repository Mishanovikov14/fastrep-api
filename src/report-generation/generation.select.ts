import { Prisma } from '../../generated/prisma/client';

export const publicGenerationSelect = {
  id: true,
  status: true,
  stage: true,
  progress: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
} satisfies Prisma.ReportGenerationSelect;
