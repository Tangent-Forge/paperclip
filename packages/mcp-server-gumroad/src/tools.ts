import { z } from "zod";
import { GumroadClient } from "./client.js";

export interface GumroadToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute: (input: Record<string, unknown>, client: GumroadClient) => Promise<unknown>;
}

function makeTool<TShape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: TShape,
  execute: (input: z.infer<z.ZodObject<TShape>>, client: GumroadClient) => Promise<unknown>,
): GumroadToolDefinition {
  const schema = z.object(shape);
  return {
    name,
    description,
    schema,
    execute: async (input, client) => execute(schema.parse(input), client),
  };
}

export const gumroadTools: GumroadToolDefinition[] = [
  makeTool(
    "gumroad_list_products",
    "List all Gumroad products for the authenticated account, including sales counts and revenue.",
    {},
    async (_input, client) => {
      return client.get("/products");
    },
  ),

  makeTool(
    "gumroad_get_sales_summary",
    "Get a summary of sales for the last N days (default 30). Returns per-product breakdown.",
    {
      days: z.number().int().min(1).max(365).default(30).describe("Number of days to look back"),
    },
    async (input, client) => {
      const after = new Date(Date.now() - input.days * 86_400_000).toISOString();
      return client.get(`/sales?after=${encodeURIComponent(after)}`);
    },
  ),

  makeTool(
    "gumroad_list_offer_codes",
    "List all offer codes for a specific Gumroad product.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
    },
    async (input, client) => {
      return client.get(`/products/${input.product_id}/offer_codes`);
    },
  ),

  makeTool(
    "gumroad_create_offer_code",
    "Create an offer code for a Gumroad product. Requires Paperclip approval gate before execution.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
      name: z.string().min(1).describe("Offer code name (e.g. LAUNCH20)"),
      amount_off: z.number().int().min(1).describe("Amount off in cents or percent"),
      offer_type: z.enum(["cents", "percent"]).describe("Whether amount_off is cents or percent"),
      max_purchase_count: z.number().int().min(1).optional().describe("Max redemptions (null = unlimited)"),
    },
    async (input, client) => {
      return client.post(`/products/${input.product_id}/offer_codes`, {
        name: input.name,
        amount_off: String(input.amount_off),
        offer_type: input.offer_type,
        ...(input.max_purchase_count ? { max_purchase_count: String(input.max_purchase_count) } : {}),
      });
    },
  ),

  makeTool(
    "gumroad_delete_offer_code",
    "Delete an offer code from a Gumroad product. Requires Paperclip approval gate.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
      offer_code_id: z.string().min(1).describe("Offer code ID to delete"),
    },
    async (input, client) => {
      return client.delete(`/products/${input.product_id}/offer_codes/${input.offer_code_id}`);
    },
  ),

  makeTool(
    "gumroad_verify_license",
    "Verify a Gumroad license key for a product. Useful for customer support automation.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID (permalink)"),
      license_key: z.string().min(1).describe("License key to verify"),
      increment_uses_count: z.boolean().default(false).describe("Whether to increment uses count"),
    },
    async (input, client) => {
      return client.post("/licenses/verify", {
        product_id: input.product_id,
        license_key: input.license_key,
        increment_uses_count: String(input.increment_uses_count),
      });
    },
  ),

  makeTool(
    "gumroad_export_sales_csv",
    "Export sales data as structured JSON (CSV format not available via API — returns sale objects).",
    {
      product_id: z.string().optional().describe("Filter by product ID (optional)"),
      days: z.number().int().min(1).max(365).default(30).describe("Number of days to export"),
    },
    async (input, client) => {
      const after = new Date(Date.now() - input.days * 86_400_000).toISOString();
      const path = input.product_id
        ? `/sales?after=${encodeURIComponent(after)}&product_id=${input.product_id}`
        : `/sales?after=${encodeURIComponent(after)}`;
      return client.get(path);
    },
  ),
];
