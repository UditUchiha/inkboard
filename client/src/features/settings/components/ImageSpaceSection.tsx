import clsx from "clsx";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../../../lib/api";
import type { ImageUsage } from "../../../lib/api";
import { formatBytes } from "../../../lib/format";
import { SettingsSection } from "./SettingsSection";

export function ImageSpaceSection() {
  const [usage, setUsage] = useState<ImageUsage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .imageUsage()
      .then(setUsage)
      .catch((loadError: unknown) => setError(errorMessage(loadError)));
  }, []);

  const percent = usage ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return (
    <SettingsSection
      title="Image space"
      description="Pictures on the boards you own count here, whoever added them. Space comes back a few hours after a picture is removed, once no saved version shows it. Emptying the trash frees it straight away."
    >
      {error && <p className="text-sm text-danger">{error}</p>}
      {!usage && !error && <p className="text-sm text-graphite">Loading…</p>}
      {usage && (
        <>
          <p className="text-sm">
            <span className="font-semibold">{formatBytes(usage.used)}</span> of {formatBytes(usage.limit)} used
          </p>
          <div
            role="meter"
            aria-label="Image space used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}%`}
            className="mt-2 h-2 overflow-hidden rounded-full bg-ink/10"
          >
            <div
              className={clsx("h-full rounded-full", percent >= 90 ? "bg-danger-solid" : "bg-signal")}
              style={{ width: `${percent}%` }}
            />
          </div>
          {usage.unverified && (
            <p className="mt-2 text-sm text-graphite">Confirm your email address to get more room.</p>
          )}
          {usage.boards.length > 0 && (
            <ul className="mt-4 divide-y divide-rule">
              {usage.boards.map((board) => (
                <li key={board.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <Link
                    to={board.trashed ? "/boards?show=trash" : `/board/${board.id}`}
                    className="min-w-0 truncate font-medium hover:underline"
                  >
                    {board.title}
                    {board.trashed && <span className="font-normal text-graphite"> (in the trash)</span>}
                  </Link>
                  <span className="shrink-0 text-graphite">
                    {formatBytes(board.bytes)} of {formatBytes(usage.boardLimit)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SettingsSection>
  );
}
