import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublicUser, publicUserSelect } from './user-select';

export type CreateUserData = {
  fullName: string;
  email: string;
  passwordHash: string;
  language: string;
};

export type UpdateUserData = Partial<
  Pick<User, 'fullName' | 'email' | 'passwordHash' | 'language' | 'photoUrl'>
>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<PublicUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
  }

  async create(data: CreateUserData): Promise<PublicUser> {
    try {
      return await this.prisma.user.create({
        data,
        select: publicUserSelect,
      });
    } catch (error) {
      this.rethrowUniqueConstraint(error);
    }
  }

  async update(id: string, data: UpdateUserData): Promise<PublicUser> {
    try {
      return await this.prisma.user.update({
        where: { id },
        data,
        select: publicUserSelect,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }

      this.rethrowUniqueConstraint(error);
    }
  }

  async delete(id: string): Promise<PublicUser> {
    try {
      return await this.prisma.user.delete({
        where: { id },
        select: publicUserSelect,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }

      throw error;
    }
  }

  private rethrowUniqueConstraint(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('A user with this email already exists');
    }

    throw error;
  }
}
