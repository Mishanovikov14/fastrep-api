import { Injectable } from '@nestjs/common';

export type HealthStatus = {
  status: 'ok';
};

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getHealth(): HealthStatus {
    return { status: 'ok' };
  }
}
