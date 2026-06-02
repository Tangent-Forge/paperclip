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
      days: z.coerce.number().int().min(1).max(365).default(30).describe("Number of days to look back"),
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
      amount_off: z.coerce.number().int().min(1).describe("Amount off in cents or percent"),
      offer_type: z.enum(["cents", "percent"]).describe("Whether amount_off is cents or percent"),
      max_purchase_count: z.coerce.number().int().min(1).optional().describe("Max redemptions (null = unlimited)"),
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

  // --- Single-product operations ---

  makeTool(
    "gumroad_get_product",
    "Get details for a single Gumroad product by ID.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
    },
    async (input, client) => {
      return client.get(`/products/${input.product_id}`);
    },
  ),

  makeTool(
    "gumroad_update_product",
    "Update a Gumroad product's name, description, price, or other fields.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
      name: z.string().optional().describe("Product name"),
      description: z.string().optional().describe("Product description (HTML allowed)"),
      price: z.number().int().min(0).optional().describe("Price in cents (0 for pay-what-you-want)"),
      suggested_price: z.number().int().min(0).optional().describe("Suggested price in cents for PWYW products"),
    },
    async (input, client) => {
      const { product_id, ...fields } = input;
      const body: Record<string, unknown> = {};
      if (fields.name !== undefined) body.name = fields.name;
      if (fields.description !== undefined) body.description = fields.description;
      if (fields.price !== undefined) body.price = String(fields.price);
      if (fields.suggested_price !== undefined) body.suggested_price = String(fields.suggested_price);
      return client.put(`/products/${product_id}`, body);
    },
  ),

  makeTool(
    "gumroad_enable_product",
    "Publish (enable) a Gumroad product so it appears in the store.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
    },
    async (input, client) => {
      return client.put(`/products/${input.product_id}/enable`, {});
    },
  ),

  makeTool(
    "gumroad_disable_product",
    "Unpublish (disable) a Gumroad product so it no longer appears in the store.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
    },
    async (input, client) => {
      return client.put(`/products/${input.product_id}/disable`, {});
    },
  ),

  // --- Sale operations ---

  makeTool(
    "gumroad_get_sale",
    "Get details for a single sale by sale ID.",
    {
      sale_id: z.string().min(1).describe("Gumroad sale ID"),
    },
    async (input, client) => {
      return client.get(`/sales/${input.sale_id}`);
    },
  ),

  makeTool(
    "gumroad_mark_sale_as_shipped",
    "Mark a physical product sale as shipped and optionally provide a tracking URL.",
    {
      sale_id: z.string().min(1).describe("Gumroad sale ID"),
      tracking_url: z.string().url().optional().describe("Shipment tracking URL (optional)"),
    },
    async (input, client) => {
      const body: Record<string, unknown> = {};
      if (input.tracking_url) body.tracking_url = input.tracking_url;
      return client.put(`/sales/${input.sale_id}/mark_as_shipped`, body);
    },
  ),

  makeTool(
    "gumroad_refund_sale",
    "Refund a sale. Requires Paperclip approval gate before execution.",
    {
      sale_id: z.string().min(1).describe("Gumroad sale ID to refund"),
      amount_cents: z.coerce.number().int().min(1).optional().describe("Partial refund amount in cents (omit for full refund)"),
    },
    async (input, client) => {
      const body: Record<string, unknown> = {};
      if (input.amount_cents !== undefined) body.amount_cents = String(input.amount_cents);
      return client.put(`/sales/${input.sale_id}/refund`, body);
    },
  ),

  // --- Subscribers ---

  makeTool(
    "gumroad_list_subscribers",
    "List subscribers for a recurring-membership Gumroad product.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
    },
    async (input, client) => {
      return client.get(`/products/${input.product_id}/subscribers`);
    },
  ),

  // --- User / account ---

  makeTool(
    "gumroad_get_user",
    "Get the authenticated Gumroad account info including balance, email, and display name.",
    {},
    async (_input, client) => {
      return client.get("/user");
    },
  ),

  // --- License lifecycle ---

  makeTool(
    "gumroad_enable_license",
    "Re-enable a previously disabled Gumroad license key.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID (permalink)"),
      license_key: z.string().min(1).describe("License key to enable"),
    },
    async (input, client) => {
      return client.put("/licenses/enable", {
        product_id: input.product_id,
        license_key: input.license_key,
      });
    },
  ),

  makeTool(
    "gumroad_disable_license",
    "Disable a Gumroad license key, e.g. for suspected fraud or chargebacks.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID (permalink)"),
      license_key: z.string().min(1).describe("License key to disable"),
    },
    async (input, client) => {
      return client.put("/licenses/disable", {
        product_id: input.product_id,
        license_key: input.license_key,
      });
    },
  ),

  makeTool(
    "gumroad_decrement_license_uses",
    "Decrement the uses count of a Gumroad license key by 1 (useful for seat-based products).",
    {
      product_id: z.string().min(1).describe("Gumroad product ID (permalink)"),
      license_key: z.string().min(1).describe("License key to decrement"),
    },
    async (input, client) => {
      return client.put("/licenses/decrement_uses_count", {
        product_id: input.product_id,
        license_key: input.license_key,
      });
    },
  ),

  // --- Offer code update ---

  makeTool(
    "gumroad_update_offer_code",
    "Update an existing offer code's max redemption count.",
    {
      product_id: z.string().min(1).describe("Gumroad product ID"),
      offer_code_id: z.string().min(1).describe("Offer code ID to update"),
      max_purchase_count: z.coerce.number().int().min(1).describe("New maximum number of redemptions"),
    },
    async (input, client) => {
      return client.put(`/products/${input.product_id}/offer_codes/${input.offer_code_id}`, {
        max_purchase_count: String(input.max_purchase_count),
      });
    },
  ),
];
