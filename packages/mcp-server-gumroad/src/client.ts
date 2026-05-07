export interface GumroadConfig {
  accessToken: string;
  baseUrl?: string;
}

export class GumroadApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GumroadApiError";
  }
}

export class GumroadClient {
  private readonly baseUrl: string;

  constructor(private readonly config: GumroadConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.gumroad.com/v2";
  }

  async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: "application/json",
    };

    let fetchBody: string | URLSearchParams | undefined;
    if (body && method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      fetchBody = new URLSearchParams(
        Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])),
      );
    }

    const response = await fetch(url, { method, headers, body: fetchBody });
    const json = (await response.json()) as Record<string, unknown>;

    if (!response.ok || json.success === false) {
      throw new GumroadApiError(
        response.status,
        method,
        path,
        (json.message as string) ?? `${method} ${path} failed with ${response.status}`,
      );
    }

    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: Record<string, unknown>) {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body: Record<string, unknown>) {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

export function createGumroadClient(): GumroadClient {
  const token = process.env.GUMROAD_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GUMROAD_ACCESS_TOKEN environment variable is required");
  }
  return new GumroadClient({ accessToken: token });
}
