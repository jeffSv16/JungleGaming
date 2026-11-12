import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

export interface ProviderIdentityPort {
  resolveProviderId(request: unknown): string | undefined;
}

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  resolveProviderId(_request: unknown): string | undefined {
    return undefined;
  }
}
