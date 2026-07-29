import {
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type ApiErrorBody = {
  code: string;
  message: string;
};

export const conflict = (code: string, message: string): ConflictException =>
  new ConflictException({ code, message } satisfies ApiErrorBody);

export const notFound = (code: string, message: string): NotFoundException =>
  new NotFoundException({ code, message } satisfies ApiErrorBody);

export const unavailable = (
  code: string,
  message: string,
): ServiceUnavailableException =>
  new ServiceUnavailableException({ code, message } satisfies ApiErrorBody);

export const tooManyRequests = (code: string, message: string): HttpException =>
  new HttpException(
    { code, message } satisfies ApiErrorBody,
    HttpStatus.TOO_MANY_REQUESTS,
  );
