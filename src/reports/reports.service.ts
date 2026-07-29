import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReportStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportAssetsService } from '../report-assets/report-assets.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import {
  PaginatedReports,
  ReportRecord,
  reportSelect,
} from './types/report.types';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportAssets: ReportAssetsService,
  ) {}

  create(userId: string, dto: CreateReportDto): Promise<ReportRecord> {
    return this.prisma.report.create({
      data: {
        userId,
        title: dto.title,
        notes: dto.notes,
        status: ReportStatus.DRAFT,
      },
      select: reportSelect,
    });
  }

  async findAll(
    userId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedReports> {
    const where: Prisma.ReportWhereInput = { userId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.report.findMany({
        where,
        select: reportSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.report.count({ where }),
    ]);

    return {
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(userId: string, id: string): Promise<ReportRecord> {
    const report = await this.prisma.report.findFirst({
      where: { id, userId },
      select: reportSelect,
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    return report;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateReportDto,
  ): Promise<ReportRecord> {
    const updated = await this.prisma.report.updateMany({
      where: { id, userId },
      data: dto,
    });

    if (updated.count === 0) {
      throw new NotFoundException('Report not found');
    }

    return this.findOne(userId, id);
  }

  async delete(userId: string, id: string): Promise<void> {
    const report = await this.prisma.report.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    await this.reportAssets.deleteObjectsForReport(userId, id);
    const deleted = await this.prisma.report.deleteMany({
      where: { id, userId },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Report not found');
    }
  }
}
