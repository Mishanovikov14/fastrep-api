import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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

  it('supports partial title and notes updates', async () => {
    const dto = plainToInstance(UpdateReportDto, {
      title: '  Updated inspection  ',
      notes: '  Updated notes.  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      title: 'Updated inspection',
      notes: 'Updated notes.',
    });
    await expect(
      validate(plainToInstance(UpdateReportDto, {})),
    ).resolves.toHaveLength(0);
  });

  it('rejects status as a non-whitelisted update field', async () => {
    await expect(
      strictValidationPipe.transform(
        { title: 'Valid', status: 'READY' },
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
