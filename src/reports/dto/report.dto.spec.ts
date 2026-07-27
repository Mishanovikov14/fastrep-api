import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReportStatus } from '../../../generated/prisma/client';
import { CreateReportDto } from './create-report.dto';
import { ListReportsQueryDto } from './list-reports-query.dto';
import { UpdateReportDto } from './update-report.dto';

const strictValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('Report DTO validation', () => {
  it('trims valid title and notes', async () => {
    const dto = plainToInstance(CreateReportDto, {
      title: '  Site inspection  ',
      notes: '  Inspect the roof.  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      title: 'Site inspection',
      notes: 'Inspect the roof.',
    });
  });

  it.each([
    { title: '' },
    { title: 'x'.repeat(121) },
    { title: 'Valid', notes: 'x'.repeat(50001) },
  ])('rejects invalid create data %#', async (input) => {
    const errors = await validate(plainToInstance(CreateReportDto, input));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('supports partial updates with a valid status enum', async () => {
    await expect(
      validate(
        plainToInstance(UpdateReportDto, {
          status: ReportStatus.PROCESSING,
        }),
      ),
    ).resolves.toHaveLength(0);
    await expect(
      validate(plainToInstance(UpdateReportDto, {})),
    ).resolves.toHaveLength(0);
  });

  it('rejects an invalid report status', async () => {
    const errors = await validate(
      plainToInstance(UpdateReportDto, { status: 'UNKNOWN' }),
    );

    expect(errors[0]?.constraints).toHaveProperty('isEnum');
  });

  it('rejects unknown update fields', async () => {
    await expect(
      strictValidationPipe.transform(
        { title: 'Valid', userId: 'another-user' },
        {
          type: 'body',
          metatype: UpdateReportDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies pagination defaults and enforces the maximum limit', async () => {
    const defaults = plainToInstance(ListReportsQueryDto, {});
    const invalid = plainToInstance(ListReportsQueryDto, {
      page: '1',
      limit: '101',
    });

    await expect(validate(defaults)).resolves.toHaveLength(0);
    expect(defaults).toMatchObject({ page: 1, limit: 20 });
    expect(await validate(invalid)).not.toHaveLength(0);
  });
});
