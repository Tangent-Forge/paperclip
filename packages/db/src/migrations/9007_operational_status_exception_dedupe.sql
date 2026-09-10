CREATE UNIQUE INDEX "issues_active_operational_status_exception_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'status_card_exception'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" not in ('done', 'cancelled');
