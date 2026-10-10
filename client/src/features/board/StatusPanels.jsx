import { CloudCheck, Eye, LoaderCircle, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { ButtonLink } from "../../components/Button";

/** Shown in place of the toolbar to people who can only look. */
export function ViewOnlyNotice({ signedIn, loginHref }) {
  return (
    <div className="floating-panel flex h-12 items-center gap-3 rounded-xl pr-2 pl-4 text-sm">
      <Eye className="size-4 shrink-0 text-graphite" aria-hidden />
      <span className="font-medium">View only</span>
      <span className="text-graphite max-lg:hidden">
        {signedIn ? "Ask the owner to invite you to edit" : "Log in if you've been invited to edit"}
      </span>
      {!signedIn && (
        <ButtonLink to={loginHref} size="sm">
          Log in
        </ButtonLink>
      )}
    </div>
  );
}

/** Whether the board is saved, saving or offline. */
export function SyncStatus({ online, saving, readOnly, local, unsaved }) {
  let icon = <CloudCheck className="size-4 text-[#2f9e44]" aria-hidden />;
  let label = readOnly ? "Up to date" : "Saved";
  if (local && unsaved) {
    icon = <WifiOff className="size-4 text-danger" aria-hidden />;
    label = "Not saved: this browser is full";
  } else if (local) {
    label = "Saved on this device";
  } else if (!online) {
    icon = <WifiOff className="size-4 text-danger" aria-hidden />;
    label = readOnly ? "Reconnecting…" : "Reconnecting… changes are kept";
  } else if (saving && !readOnly) {
    icon = <LoaderCircle className="size-4 animate-spin text-graphite" aria-hidden />;
    label = "Saving…";
  }
  // "Saving…" flashes on every 40 ms flush, so screen readers only hear the states that last.
  const working = label === "Saving…";
  const [announced, setAnnounced] = useState(label);
  useEffect(() => {
    if (!working) setAnnounced(label);
  }, [label, working]);
  return (
    <div className="floating-panel flex h-10 items-center gap-2 rounded-xl px-3 text-sm text-graphite">
      {icon}
      <span className="max-sm:sr-only" aria-hidden>
        {label}
      </span>
      <span role="status" className="sr-only">
        {announced}
      </span>
    </div>
  );
}
