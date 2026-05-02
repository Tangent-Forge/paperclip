import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArchiveRestore,
  Archive,
  Ban,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
} from "lucide-react";
import type {
  CompanySecret,
  CompanySecretBinding,
  SecretAccessEvent,
  SecretManagedMode,
  SecretProvider,
  SecretProviderDescriptor,
  SecretStatus,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { secretsApi, type CreateSecretInput, type SecretProviderHealthResponse } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

type CreateMode = "managed" | "external";

function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function statusBadgeTone(status: SecretStatus) {
  switch (status) {
    case "active":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
    case "disabled":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
    case "archived":
      return "bg-muted text-muted-foreground border-border";
    case "deleted":
      return "bg-destructive/10 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function providerLabel(providers: SecretProviderDescriptor[] | undefined, id: SecretProvider) {
  return providers?.find((p) => p.id === id)?.label ?? id.replaceAll("_", " ");
}

function normalizeSecretKeyForPreview(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function modeBadgeTone(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
}

function modeLabel(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed" ? "Paperclip-managed" : "Linked external";
}

function modeDescription(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed"
    ? "Paperclip owns create and rotation writes for this provider secret."
    : "Paperclip resolves this provider reference but does not rotate the provider value.";
}

function healthEntryForProvider(
  health: SecretProviderHealthResponse | null,
  providerId: SecretProvider,
) {
  return health?.providers.find((entry) => entry.provider === providerId) ?? null;
}

export function getCreateProviderBlockReason(
  provider: SecretProviderDescriptor | null | undefined,
  mode: CreateMode,
  health: SecretProviderHealthResponse | null,
) {
  if (!provider) return "Select a provider.";
  if (mode === "managed" && provider.supportsManagedValues === false) {
    return `${provider.label} does not support Paperclip-managed secret values.`;
  }
  if (mode === "external" && provider.supportsExternalReferences === false) {
    return `${provider.label} does not support linked external references.`;
  }
  if (provider.configured === false) {
    return `${provider.label} is not configured in this deployment.`;
  }
  const healthEntry = healthEntryForProvider(health, provider.id);
  if (healthEntry?.status === "error") {
    return `${provider.label} health check failed: ${healthEntry.message}`;
  }
  return null;
}

function providerHealthText(
  provider: SecretProviderDescriptor | null | undefined,
  health: SecretProviderHealthResponse | null,
) {
  if (!provider) return null;
  const entry = healthEntryForProvider(health, provider.id);
  if (!entry) return null;
  const warnings = entry.warnings?.join(" ");
  return [entry.message, warnings].filter(Boolean).join(" ");
}

function detailString(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getAwsManagedPathPreview(input: {
  provider: SecretProviderDescriptor | null | undefined;
  health: SecretProviderHealthResponse | null;
  companyId: string;
  secretKeySource: string;
}) {
  if (input.provider?.id !== "aws_secrets_manager") return null;
  const healthEntry = healthEntryForProvider(input.health, "aws_secrets_manager");
  const prefix = detailString(healthEntry?.details, "prefix") ?? "paperclip";
  const deploymentId = detailString(healthEntry?.details, "deploymentId") ?? "{deploymentId}";
  const secretKey = normalizeSecretKeyForPreview(input.secretKeySource) || "{secretKey}";
  return `${prefix}/${deploymentId}/${input.companyId}/${secretKey}`;
}

export function Secrets() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SecretStatus | "all">("active");
  const [providerFilter, setProviderFilter] = useState<SecretProvider | "all">("all");
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("managed");
  const [createForm, setCreateForm] = useState({
    name: "",
    key: "",
    value: "",
    description: "",
    externalRef: "",
    provider: "local_encrypted" as SecretProvider,
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateExternalRef, setRotateExternalRef] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CompanySecret | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Secrets" }]);
  }, [setBreadcrumbs]);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const providersQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.providers(selectedCompanyId)
      : ["secret-providers", "__disabled__"],
    queryFn: () => secretsApi.providers(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    staleTime: 5 * 60_000,
  });

  const providerHealthQuery = useQuery({
    queryKey: selectedCompanyId
      ? ["secret-provider-health", selectedCompanyId]
      : ["secret-provider-health", "__disabled__"],
    queryFn: () => secretsApi.providerHealth(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
    retry: false,
  });

  const secrets = secretsQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.id === selectedSecretId) ?? null,
    [secrets, selectedSecretId],
  );
  const selectedCreateProvider = useMemo(
    () => providers.find((provider) => provider.id === createForm.provider) ?? null,
    [providers, createForm.provider],
  );
  const createProviderBlockReason = getCreateProviderBlockReason(
    selectedCreateProvider,
    createMode,
    providerHealthQuery.data ?? null,
  );
  const createProviderHealthText = providerHealthText(
    selectedCreateProvider,
    providerHealthQuery.data ?? null,
  );
  const awsManagedPathPreview = getAwsManagedPathPreview({
    provider: selectedCreateProvider,
    health: providerHealthQuery.data ?? null,
    companyId: selectedCompanyId ?? "{companyId}",
    secretKeySource: createForm.key.trim() || createForm.name,
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return secrets.filter((secret) => {
      if (statusFilter !== "all" && secret.status !== statusFilter) return false;
      if (providerFilter !== "all" && secret.provider !== providerFilter) return false;
      if (!needle) return true;
      return (
        secret.name.toLowerCase().includes(needle) ||
        secret.key.toLowerCase().includes(needle) ||
        (secret.description?.toLowerCase().includes(needle) ?? false) ||
        (secret.externalRef?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [secrets, search, statusFilter, providerFilter]);

  const usageQuery = useQuery({
    queryKey: selectedSecret ? queryKeys.secrets.usage(selectedSecret.id) : ["secrets", "usage", "__disabled__"],
    queryFn: () => secretsApi.usage(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });
  const eventsQuery = useQuery({
    queryKey: selectedSecret
      ? queryKeys.secrets.accessEvents(selectedSecret.id)
      : ["secrets", "access-events", "__disabled__"],
    queryFn: () => secretsApi.accessEvents(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });

  function invalidateAll(extraIds: string[] = []) {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    for (const id of extraIds) {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.usage(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.accessEvents(id) });
    }
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const input: CreateSecretInput = {
        name: createForm.name.trim(),
        provider: createForm.provider,
        managedMode: createMode === "external" ? "external_reference" : "paperclip_managed",
        description: createForm.description.trim() || null,
      };
      if (createForm.key.trim()) input.key = createForm.key.trim();
      if (createMode === "managed") {
        input.value = createForm.value;
      } else {
        input.externalRef = createForm.externalRef.trim();
      }
      return secretsApi.create(selectedCompanyId!, input);
    },
    onSuccess: (created) => {
      pushToast({ title: "Secret created", body: created.name, tone: "success" });
      setCreateOpen(false);
      setCreateForm({ name: "", key: "", value: "", description: "", externalRef: "", provider: createForm.provider });
      setCreateError(null);
      setSelectedSecretId(created.id);
      invalidateAll([created.id]);
    },
    onError: (error) => {
      setCreateError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!selectedSecret) throw new Error("Select a secret first");
      if (selectedSecret.managedMode === "external_reference") {
        return secretsApi.rotate(selectedSecret.id, {
          externalRef: rotateExternalRef.trim() || selectedSecret.externalRef || undefined,
        });
      }
      return secretsApi.rotate(selectedSecret.id, { value: rotateValue });
    },
    onSuccess: (updated) => {
      pushToast({ title: "Rotated", body: `${updated.name} → v${updated.latestVersion}`, tone: "success" });
      setRotateOpen(false);
      setRotateValue("");
      setRotateExternalRef("");
      setRotateError(null);
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      setRotateError(error instanceof Error ? error.message : "Rotate failed");
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SecretStatus }) => {
      switch (status) {
        case "active":
          return secretsApi.enable(id);
        case "disabled":
          return secretsApi.disable(id);
        case "archived":
          return secretsApi.archive(id);
        default:
          return secretsApi.update(id, { status });
      }
    },
    onSuccess: (updated) => {
      pushToast({ title: `Secret ${updated.status}`, body: updated.name, tone: "info" });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      pushToast({
        title: "Status update failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_response, id) => {
      pushToast({ title: "Secret deleted", tone: "info" });
      setDeleteConfirm(null);
      if (selectedSecretId === id) setSelectedSecretId(null);
      invalidateAll([id]);
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Try again",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!createOpen || providers.length === 0) return;
    const currentBlockReason = getCreateProviderBlockReason(
      providers.find((provider) => provider.id === createForm.provider) ?? null,
      createMode,
      providerHealthQuery.data ?? null,
    );
    if (!currentBlockReason) return;
    const replacement = providers.find(
      (provider) =>
        !getCreateProviderBlockReason(provider, createMode, providerHealthQuery.data ?? null),
    );
    if (replacement && replacement.id !== createForm.provider) {
      setCreateForm((current) => ({ ...current, provider: replacement.id }));
    }
  }, [createForm.provider, createMode, createOpen, providerHealthQuery.data, providers]);

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Select a company to manage secrets.</div>
    );
  }

  const activeProviders = providers.length;
  const activeSecrets = secrets.filter((s) => s.status === "active").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Secrets</h1>
          <span className="text-xs text-muted-foreground">
            {activeSecrets}/{secrets.length} active · {activeProviders} provider{activeProviders === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-1 items-center gap-2 justify-end">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, key, ref"
              className="pl-7 h-8 w-64"
            />
          </div>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as SecretStatus | "all")}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="archived">Archived</option>
          </select>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value as SecretProvider | "all")}
          >
            <option value="all">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-3.5 w-3.5 mr-1" /> New secret
          </Button>
        </div>
      </header>

      <ProviderHealthBar
        providers={providers}
        health={providerHealthQuery.data ?? null}
        loading={providersQuery.isPending}
        error={providersQuery.error ?? providerHealthQuery.error}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {secretsQuery.isError ? (
          <div className="p-6 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Failed to load secrets:{" "}
            {(secretsQuery.error as Error).message}
            <Button variant="ghost" size="sm" onClick={() => secretsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : secrets.length === 0 && !secretsQuery.isPending ? (
          <EmptyState
            icon={KeyRound}
            message="No secrets yet. Create your first managed secret or link an external reference."
            action="New secret"
            onAction={() => setCreateOpen(true)}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} message="No secrets match your filters." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-6 py-2 text-left font-medium">Name</th>
                <th className="px-2 py-2 text-left font-medium">Mode</th>
                <th className="px-2 py-2 text-left font-medium">Provider</th>
                <th className="px-2 py-2 text-left font-medium">Status</th>
                <th className="px-2 py-2 text-left font-medium">Version</th>
                <th className="px-2 py-2 text-left font-medium">Last rotated</th>
                <th className="px-2 py-2 text-left font-medium">Last resolved</th>
                <th className="px-2 py-2 text-left font-medium">Reference</th>
                <th className="px-6 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((secret) => (
                <tr
                  key={secret.id}
                  className={cn(
                    "border-b border-border/60 hover:bg-accent/40 cursor-pointer",
                    selectedSecretId === secret.id && "bg-accent/60",
                  )}
                  onClick={() => setSelectedSecretId(secret.id)}
                >
                  <td className="px-6 py-2.5">
                    <div className="font-medium text-foreground">{secret.name}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">{secret.key}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    <Badge variant="outline" className={cn("font-medium", modeBadgeTone(secret.managedMode))}>
                      {modeLabel(secret.managedMode)}
                    </Badge>
                  </td>
                  <td className="px-2 py-2.5 text-xs">{providerLabel(providers, secret.provider)}</td>
                  <td className="px-2 py-2.5">
                    <Badge variant="outline" className={cn("font-medium", statusBadgeTone(secret.status))}>
                      {secret.status}
                    </Badge>
                  </td>
                  <td className="px-2 py-2.5 text-xs font-mono">v{secret.latestVersion}</td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground">
                    {formatRelative(secret.lastRotatedAt)}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground">
                    {formatRelative(secret.lastResolvedAt)}
                  </td>
                  <td className="px-2 py-2.5 text-xs">
                    {secret.managedMode === "external_reference" ? (
                      <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
                        <Link2 className="h-3 w-3" />
                        {secret.externalRef ?? "—"}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Owned by Paperclip</span>
                    )}
                  </td>
                  <td className="px-6 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedSecretId(secret.id);
                      }}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Sheet open={Boolean(selectedSecret)} onOpenChange={(open) => !open && setSelectedSecretId(null)}>
        <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0">
          {selectedSecret ? (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4" />
                  {selectedSecret.name}
                  <Badge variant="outline" className={cn("ml-2", statusBadgeTone(selectedSecret.status))}>
                    {selectedSecret.status}
                  </Badge>
                  <Badge variant="outline" className={cn(modeBadgeTone(selectedSecret.managedMode))}>
                    {modeLabel(selectedSecret.managedMode)}
                  </Badge>
                </SheetTitle>
                <SheetDescription>
                  {providerLabel(providers, selectedSecret.provider)} · v{selectedSecret.latestVersion} ·{" "}
                  <span className="font-mono">{selectedSecret.key}</span>
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-wrap gap-2 px-4 pb-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRotateOpen(true);
                    setRotateValue("");
                    setRotateExternalRef("");
                    setRotateError(null);
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  {selectedSecret.managedMode === "external_reference" ? "Update reference" : "Rotate"}
                </Button>
                {selectedSecret.status === "active" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "disabled" })}
                    disabled={statusMutation.isPending}
                  >
                    <Ban className="h-3.5 w-3.5 mr-1" /> Disable
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "active" })}
                    disabled={statusMutation.isPending}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Activate
                  </Button>
                )}
                {selectedSecret.status === "archived" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "active" })}
                    disabled={statusMutation.isPending}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5 mr-1" /> Unarchive
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => statusMutation.mutate({ id: selectedSecret.id, status: "archived" })}
                    disabled={statusMutation.isPending}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" /> Archive
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteConfirm(selectedSecret)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                </Button>
              </div>
              <Tabs defaultValue="details" className="flex-1 min-h-0 flex flex-col">
                <TabsList className="mx-4">
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="usage">
                    Usage{usageQuery.data ? ` (${usageQuery.data.bindings.length})` : ""}
                  </TabsTrigger>
                  <TabsTrigger value="events">Access events</TabsTrigger>
                </TabsList>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                  <TabsContent value="details">
                    <SecretDetailsTab secret={selectedSecret} />
                  </TabsContent>
                  <TabsContent value="usage">
                    <SecretUsageTab loading={usageQuery.isPending} bindings={usageQuery.data?.bindings ?? []} />
                  </TabsContent>
                  <TabsContent value="events">
                    <SecretEventsTab loading={eventsQuery.isPending} events={eventsQuery.data ?? []} />
                  </TabsContent>
                </div>
              </Tabs>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create secret</DialogTitle>
            <DialogDescription>
              Choose whether Paperclip should own future provider writes, or only resolve an existing
              provider reference at runtime.
            </DialogDescription>
          </DialogHeader>
          <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="managed">Managed value</TabsTrigger>
              <TabsTrigger value="external">External reference</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-name">Name</label>
                <Input
                  id="new-secret-name"
                  value={createForm.name}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="OPENAI_API_KEY"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-key">
                  Key <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="new-secret-key"
                  value={createForm.key}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, key: event.target.value }))
                  }
                  placeholder="auto from name"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="new-secret-provider">Provider</label>
              <select
                id="new-secret-provider"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none"
                value={createForm.provider}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, provider: event.target.value as SecretProvider }))
                }
              >
                {providers.map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={Boolean(
                      getCreateProviderBlockReason(provider, createMode, providerHealthQuery.data ?? null),
                    )}
                  >
                    {provider.label}
                    {provider.configured === false
                      ? " (not configured)"
                      : provider.requiresExternalRef
                        ? " (external only)"
                        : ""}
                  </option>
                ))}
              </select>
              {createProviderBlockReason ? (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {createProviderBlockReason}
                </p>
              ) : createProviderHealthText ? (
                <p className="mt-1 text-[11px] text-muted-foreground">{createProviderHealthText}</p>
              ) : null}
            </div>
            {createMode === "managed" ? (
              <>
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  Paperclip-managed secrets are created in the selected provider and future rotations
                  write a new provider version through Paperclip.
                  {awsManagedPathPreview ? (
                    <div className="mt-1">
                      AWS managed path:{" "}
                      <code className="break-all rounded bg-background/70 px-1 py-0.5">
                        {awsManagedPathPreview}
                      </code>
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="text-xs font-medium" htmlFor="new-secret-value">Value</label>
                  <Textarea
                    id="new-secret-value"
                    value={createForm.value}
                    onChange={(event) =>
                      setCreateForm((current) => ({ ...current, value: event.target.value }))
                    }
                    rows={3}
                    className="font-mono text-xs"
                    placeholder="Stored once, never re-displayed"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="text-xs font-medium" htmlFor="new-secret-ref">External reference</label>
                <Input
                  id="new-secret-ref"
                  value={createForm.externalRef}
                  onChange={(event) =>
                    setCreateForm((current) => ({ ...current, externalRef: event.target.value }))
                  }
                  placeholder="arn:aws:secretsmanager:..."
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Existing provider secrets are resolve-only in Paperclip. Rotate the value in the provider,
                  then update this reference only if the path, ARN, or version changes.
                </p>
              </div>
            )}
            <div>
              <label className="text-xs font-medium" htmlFor="new-secret-description">
                Description <span className="text-muted-foreground/70">(optional)</span>
              </label>
              <Input
                id="new-secret-description"
                value={createForm.description}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="What is this secret used for? (no values)"
              />
            </div>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setCreateError(null);
                createMutation.mutate();
              }}
              disabled={
                createMutation.isPending ||
                Boolean(createProviderBlockReason) ||
                !createForm.name.trim() ||
                (createMode === "managed" ? !createForm.value : !createForm.externalRef.trim())
              }
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {createMode === "managed" ? "Create secret" : "Link reference"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedSecret?.managedMode === "external_reference" ? "Update external reference" : "Rotate secret"}
            </DialogTitle>
            <DialogDescription>
              {selectedSecret?.managedMode === "external_reference"
                ? "Creates a new Paperclip metadata version that points at an existing provider secret. Paperclip does not write a new provider value."
                : "Creates a new provider-backed version. Consumers pinned to latest pick up the new value on the next run."}
            </DialogDescription>
          </DialogHeader>
          {selectedSecret?.managedMode === "external_reference" ? (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-ref">External reference</label>
              <Input
                id="rotate-ref"
                value={rotateExternalRef}
                onChange={(event) => setRotateExternalRef(event.target.value)}
                placeholder={selectedSecret.externalRef ?? "Updated reference"}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Rotate the actual value in the provider before changing this Paperclip reference.
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium" htmlFor="rotate-value">New value</label>
              <Textarea
                id="rotate-value"
                value={rotateValue}
                onChange={(event) => setRotateValue(event.target.value)}
                rows={3}
                className="font-mono text-xs"
                placeholder="Paste the new value"
              />
            </div>
          )}
          {rotateError ? <p className="text-xs text-destructive">{rotateError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRotateError(null);
                rotateMutation.mutate();
              }}
              disabled={
                rotateMutation.isPending ||
                (selectedSecret?.managedMode === "external_reference"
                  ? !rotateExternalRef.trim() && !selectedSecret?.externalRef
                  : !rotateValue)
              }
            >
              {rotateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {selectedSecret?.managedMode === "external_reference" ? "Update reference" : "Rotate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Permanently removes <strong>{deleteConfirm?.name}</strong>. Active bindings will fail until you remap them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderHealthBar({
  providers,
  health,
  loading,
  error,
}: {
  providers: SecretProviderDescriptor[];
  health: SecretProviderHealthResponse | null;
  loading: boolean;
  error: unknown;
}) {
  if (loading || providers.length === 0) return null;

  const healthMap = new Map(health?.providers.map((entry) => [entry.provider, entry]) ?? []);
  const worstStatus = (() => {
    if (error) return "error" as const;
    let worst: "ok" | "warn" | "error" = "ok";
    for (const entry of healthMap.values()) {
      if (entry.status === "error") return "error" as const;
      if (entry.status === "warn") worst = "warn";
    }
    return worst;
  })();

  const tone =
    worstStatus === "error"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : worstStatus === "warn"
        ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
        : "border-border bg-muted/30 text-muted-foreground";
  const dot = (status: "ok" | "warn" | "error") =>
    status === "error" ? "bg-destructive" : status === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const message = error
    ? "Provider health check failed."
    : worstStatus === "error"
      ? "One or more providers reported errors."
      : worstStatus === "warn"
        ? "Provider warnings detected — review setup."
        : `Connected to ${providers.length} provider${providers.length === 1 ? "" : "s"}`;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-b px-6 py-1.5 text-[11px]", tone)}>
      <Wifi className="h-3 w-3" />
      <span>{message}</span>
      <span>·</span>
      <span className="flex flex-wrap items-center gap-2">
        {providers.map((provider) => {
          const entry = healthMap.get(provider.id);
          const status = entry?.status ?? "ok";
          const warningCount = entry?.warnings?.length ?? 0;
          return (
            <span
              key={provider.id}
              className="inline-flex items-center gap-1"
              title={entry?.message ?? provider.label}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", dot(status))} />
              {provider.label}
              {warningCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {warningCount} warning{warningCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function SecretDetailsTab({ secret }: { secret: CompanySecret }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
      <DetailRow label="Description">
        <span>{secret.description ?? <span className="text-muted-foreground">—</span>}</span>
      </DetailRow>
      <DetailRow label="Custody">{modeLabel(secret.managedMode)}</DetailRow>
      <DetailRow label="Provider">{secret.provider.replaceAll("_", " ")}</DetailRow>
      <DetailRow label="Latest version">v{secret.latestVersion}</DetailRow>
      <DetailRow label="Created">{formatRelative(secret.createdAt)}</DetailRow>
      <DetailRow label="Updated">{formatRelative(secret.updatedAt)}</DetailRow>
      <DetailRow label="Last rotated">{formatRelative(secret.lastRotatedAt)}</DetailRow>
      <DetailRow label="Last resolved">{formatRelative(secret.lastResolvedAt)}</DetailRow>
      {secret.externalRef ? (
        <div className="col-span-2">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {secret.managedMode === "external_reference" ? "Linked provider reference" : "Provider-managed path"}
          </dt>
          <dd className="font-mono text-xs break-all flex items-center gap-1">
            <ExternalLink className="h-3 w-3" /> {secret.externalRef}
          </dd>
        </div>
      ) : null}
      <div className="col-span-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
        {modeDescription(secret.managedMode)} Paperclip never re-displays stored values.
      </div>
    </dl>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function SecretUsageTab({ loading, bindings }: { loading: boolean; bindings: CompanySecretBinding[] }) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>;
  }
  if (bindings.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        No active bindings. Add this secret in agent, project, environment, or plugin config to start using it.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {bindings.map((binding) => (
        <div
          key={binding.id}
          className="rounded-md border border-border bg-muted/30 p-2 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium capitalize">{binding.targetType}</span>
            <span className="font-mono text-muted-foreground">v{binding.versionSelector}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {binding.targetId}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {binding.configPath} {binding.required ? "· required" : "· optional"}
          </div>
        </div>
      ))}
    </div>
  );
}

function SecretEventsTab({ loading, events }: { loading: boolean; events: SecretAccessEvent[] }) {
  if (loading) {
    return <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>;
  }
  if (events.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        No access events recorded yet. Each runtime resolution writes a redacted entry here.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {events.map((event) => (
        <div key={event.id} className="rounded border border-border px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="capitalize">
              {event.consumerType} · {event.outcome}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelative(event.createdAt)}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            {event.consumerId}
          </div>
          {event.errorCode ? (
            <div className="text-[11px] text-destructive">{event.errorCode}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
