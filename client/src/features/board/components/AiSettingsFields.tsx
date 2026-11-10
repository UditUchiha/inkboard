import { ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import { PasswordField, TextField } from "../../../components/Field";
import { listModels } from "../lib/ai/askModel";
import { PROVIDER_IDS, PROVIDERS } from "../lib/ai/providers";
import type { AiSettings, ProviderId } from "../lib/ai/providers";

interface AiSettingsFieldsProps {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}

export function AiSettingsFields({ settings, onChange }: AiSettingsFieldsProps) {
  const providerId = useId();
  const modelsId = useId();
  const [models, setModels] = useState<string[]>([]);
  const latestLoad = useRef(0);
  const provider = PROVIDERS[settings.provider];
  const key = settings.keys[settings.provider] ?? "";

  const loadModels = (next: AiSettings) => {
    const load = ++latestLoad.current;
    setModels([]);
    if (!next.keys[next.provider]) return;
    void listModels(next).then((ids) => {
      if (load === latestLoad.current) setModels(ids);
    });
  };

  const handleProviderChange = (id: ProviderId) => {
    const next = { ...settings, provider: id };
    onChange(next);
    loadModels(next);
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <label htmlFor={providerId} className="text-sm font-medium text-ink">
          Provider
        </label>
        <div className="relative">
          <select
            id={providerId}
            value={settings.provider}
            onChange={(event) => handleProviderChange(event.target.value as ProviderId)}
            className="h-11 w-full appearance-none rounded-lg border border-rule bg-surface pr-10 pl-3 text-[15px] text-ink hover:border-graphite/60 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
          >
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id].label}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-graphite"
          />
        </div>
      </div>
      <PasswordField
        label={`Your ${provider.label} API key`}
        autoComplete="off"
        value={key}
        onChange={(event) =>
          onChange({ ...settings, keys: { ...settings.keys, [settings.provider]: event.target.value } })
        }
        onBlur={() => loadModels(settings)}
        placeholder={provider.keyPlaceholder}
        required
        hint={
          <>
            Kept only in this browser and sent only to {provider.label}, which bills your account. Get one at{" "}
            <a href={provider.keyUrl} target="_blank" rel="noopener" className="underline">
              {new URL(provider.keyUrl).hostname}
            </a>
            .
          </>
        }
      />
      <TextField
        label="Model"
        list={modelsId}
        value={settings.models[settings.provider] ?? ""}
        onChange={(event) =>
          onChange({ ...settings, models: { ...settings.models, [settings.provider]: event.target.value } })
        }
        onFocus={() => {
          if (models.length === 0) loadModels(settings);
        }}
        placeholder={provider.defaultModel}
        hint={
          models.length > 0 ? `${models.length} models available to this key` : `Empty uses ${provider.defaultModel}`
        }
      />
      <datalist id={modelsId}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}
