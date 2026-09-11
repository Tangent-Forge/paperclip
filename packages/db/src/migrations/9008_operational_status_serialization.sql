ALTER TABLE "status_cards" ADD COLUMN "operational_generation_update_id" uuid;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD COLUMN "operational_claim_id" uuid;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD CONSTRAINT "status_card_updates_operational_claim_id_operational_status_claims_id_fk" FOREIGN KEY ("operational_claim_id") REFERENCES "public"."operational_status_claims"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "status_cards" ADD CONSTRAINT "status_cards_operational_generation_update_id_status_card_updates_id_fk" FOREIGN KEY ("operational_generation_update_id") REFERENCES "public"."status_card_updates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "status_card_updates_operational_claim_uq" ON "status_card_updates" USING btree ("operational_claim_id");
