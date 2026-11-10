import clsx from "clsx";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { Button, IconButton } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/Dialog";
import { TextField } from "../../../components/Field";
import { api, errorMessage } from "../../../lib/api";
import type { ApiTokenInfo } from "../../../lib/api";
import { timeAgo } from "../../../lib/format";
import { SettingsSection } from "./SettingsSection";

const SCOPES: [ApiTokenInfo["scope"], string][] = [
  ["read", "Read boards"],
  ["write", "Read and change boards"],
];

export function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenInfo["scope"]>("read");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null); // the token just made, shown this once
  const [deleting, setDeleting] = useState<ApiTokenInfo | null>(null);

  useEffect(() => {
    api
      .listApiTokens()
      .then(({ tokens: list }) => setTokens(list))
      .catch((loadError: unknown) => setError(errorMessage(loadError)));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token, info } = await api.createApiToken(name.trim(), scope);
      setTokens((list) => [info, ...(list ?? [])]);
      setMade(token);
      setName("");
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  }

  async function remove(token: ApiTokenInfo) {
    try {
      await api.deleteApiToken(token.id);
      setTokens((list) => list?.filter((item) => item.id !== token.id) ?? null);
      toast.success(`“${token.name}” deleted. Anything using it can't any more.`);
    } catch (deleteError) {
      toast.error(errorMessage(deleteError));
    }
    setDeleting(null);
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Token copied");
    } catch {
      toast.error("Couldn't copy it. Select it and copy it instead.");
    }
  }

  return (
    <SettingsSection
      title="API tokens"
      description={`Let scripts and AI assistants use your boards: the API is at ${window.location.origin}/api/v1 and the MCP server at ${window.location.origin}/mcp. A token can do on each board what you can, and one that only reads can't change anything.`}
    >
      {made && (
        <div className="mb-5 rounded-lg border border-signal/40 bg-signal/5 p-3">
          <p className="text-sm font-medium">Copy your new token now. You won't be able to see it again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1.5 text-sm select-all">
              {made}
            </code>
            <IconButton label="Copy token" icon={Copy} onClick={() => copy(made)} />
          </div>
        </div>
      )}
      <form onSubmit={create} className="grid gap-3">
        <TextField
          label="Token name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="My script"
          required
        />
        <div role="radiogroup" aria-label="What it can do" className="flex flex-wrap gap-1.5">
          {SCOPES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              onClick={() => setScope(value)}
              className={clsx(
                "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                scope === value ? "border-signal bg-signal/5 font-medium" : "border-rule hover:border-graphite/60",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div>
          <Button type="submit" icon={KeyRound} loading={busy}>
            Make a token
          </Button>
        </div>
      </form>
      {tokens && tokens.length > 0 && (
        <ul className="mt-5 divide-y divide-rule border-t border-rule">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{token.name}</p>
                <p className="text-graphite">
                  <code>{token.start}…</code> · {token.scope === "write" ? "reads and changes" : "reads"} ·{" "}
                  {token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : "never used"}
                </p>
              </div>
              <IconButton label={`Delete “${token.name}”`} icon={Trash2} onClick={() => setDeleting(token)} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting)}
        title={`Delete “${deleting?.name}”?`}
        description="Anything using this token stops working straight away."
        confirmLabel="Delete token"
      />
    </SettingsSection>
  );
}
