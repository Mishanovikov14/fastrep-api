import { ConflictException } from '@nestjs/common';
import { ReportStatus } from '../../generated/prisma/client';

export const EDITABLE_REPORT_STATUSES: readonly ReportStatus[] = [
  ReportStatus.DRAFT,
  ReportStatus.FAILED,
];

export const assertReportEditable = (status: ReportStatus): void => {
  if (EDITABLE_REPORT_STATUSES.includes(status)) {
    return;
  }

  if (status === ReportStatus.QUEUED || status === ReportStatus.PROCESSING) {
    throw new ConflictException({
      code: 'REPORT_GENERATION_ACTIVE',
      message: 'The report cannot be changed while generation is active',
    });
  }

  throw new ConflictException({
    code: 'REPORT_NOT_EDITABLE',
    message: 'The report cannot be changed in its current state',
  });
};
