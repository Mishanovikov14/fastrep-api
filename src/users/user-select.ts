import { Prisma } from '../../generated/prisma/client';

export const publicUserSelect = {
  id: true,
  fullName: true,
  email: true,
  language: true,
  photoUrl: true,
  isPremium: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;
