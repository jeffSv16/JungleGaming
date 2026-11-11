import { Entity, PrimaryKey, Property, Index } from "@mikro-orm/core";

@Entity({ tableName: "outbox_messages" })
@Index({
  properties: ["publishedAt", "nextAttemptAt"],
  name: "idx_outbox_due",
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "aggregate_id", type: "uuid" })
  aggregateId!: string;

  @Property({ fieldName: "event_type", length: 128 })
  eventType!: string;

  @Property({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ fieldName: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Property({ type: "int", default: 0 })
  attempts: number = 0;

  @Property({ fieldName: "next_attempt_at", type: "timestamptz", nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: "published_at", type: "timestamptz", nullable: true })
  publishedAt?: Date;
}
