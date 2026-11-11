import type { EntityManager } from "@mikro-orm/postgresql";

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

export interface UnitOfWork {
  transactional<T>(work: (em: EntityManager) => Promise<T>): Promise<T>;
}
