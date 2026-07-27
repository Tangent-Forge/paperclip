import { useEffect, useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { PayloadTemplateJsonField } from "../runtime-json-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function HeadersJsonField({
  isCreate,
  values,
  set,
  config,
  mark,
}: Pick<AdapterConfigFieldsProps, "isCreate" | "values" | "set" | "config" | "mark">) {
  const existing = JSON.stringify(config.headers ?? {}, null, 2);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.headersJson ?? "" : draft;

  return (
    <Field label="Headers JSON" hint={help.headersJson}>
      <textarea
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (isCreate) {
            set?.({ headersJson: next });
            return;
          }

          setDraft(next);
          const trimmed = next.trim();
          if (!trimmed) {
            mark("adapterConfig", "headers", undefined);
            return;
          }

          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              mark("adapterConfig", "headers", parsed);
            }
          } catch {
            // Keep the visible draft until the JSON is valid.
          }
        }}
        rows={4}
        className={inputClass}
        placeholder='{\n  "Authorization": "Bearer ...",\n  "X-API-Key": "..."\n}'
      />
    </Field>
  );
}

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Webhook URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://..."
        />
      </Field>

      <HeadersJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      <PayloadTemplateJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />
    </>
  );
}
