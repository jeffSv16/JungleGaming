import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
@Unique({
  properties: ["consumerName", "messageId"],
  name: "uq_inbox_consumer_message",
})
export class InboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "message_id", length: 256 })
  messageId!: string;

  @Property({ fieldName: "consumer_name", length: 128 })
  consumerName!: string;

  @Property({ fieldName: "payload_hash", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date;
}
