import { AuthController } from './auth/auth.controller';
import { EntitlementsController } from './entitlements/entitlements.controller';
import { ReportAssetsController } from './report-assets/report-assets.controller';
import { ReportGenerationsController } from './report-generation/report-generations.controller';
import { ReportOutputsController } from './report-generation/report-outputs.controller';
import { ReportsController } from './reports/reports.controller';

type Controller = abstract new (...args: never[]) => unknown;
type SecurityRequirement = Record<string, string[]>;

const SWAGGER_API_SECURITY_METADATA = 'swagger/apiSecurity';

const controllers: Controller[] = [
  AuthController,
  EntitlementsController,
  ReportAssetsController,
  ReportGenerationsController,
  ReportOutputsController,
  ReportsController,
];

describe('Swagger bearer authentication metadata', () => {
  it('references the registered access-token scheme on every secured controller and endpoint', () => {
    const securityRequirements = controllers.flatMap((controller) => [
      ...readSecurityRequirements(controller),
      ...Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          controller.prototype,
          name,
        );
        const method: unknown = descriptor?.value;
        return readSecurityRequirements(method);
      }),
    ]);

    expect(securityRequirements.length).toBeGreaterThan(0);
    for (const requirement of securityRequirements) {
      expect(Object.keys(requirement)).toEqual(['access-token']);
    }
  });
});

function readSecurityRequirements(target: unknown): SecurityRequirement[] {
  if (
    (typeof target !== 'function' && typeof target !== 'object') ||
    target === null
  ) {
    return [];
  }

  return (
    (Reflect.getMetadata(
      SWAGGER_API_SECURITY_METADATA,
      target,
    ) as SecurityRequirement[]) ?? []
  );
}
