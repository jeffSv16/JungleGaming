import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Auth extension point (challenge §2).
 * No-op by default — AUTH_MODE=noop.
 * Swap for an OIDC guard (Keycloak/Zitadel) without changing controllers.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

/** Port for resolving provider identity from an authenticated principal. */
export interface ProviderIdentityPort {
  resolveProviderId(request: unknown): string | undefined;
}

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  resolveProviderId(_request: unknown): string | undefined {
    return undefined;
  }
}
