import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

type AuthenticatedRequest = Request & { userId: string };

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.userId;
  },
);
