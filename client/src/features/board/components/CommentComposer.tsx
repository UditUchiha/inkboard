import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/Button";
import { errorMessage } from "../../../lib/api";
import type { Person } from "../../../lib/api";
import type { NewMessage } from "../hooks/useThreads";
import { MentionTextarea } from "./MentionTextarea";

type ComposerProps = {
  members: Person[];
  submitLabel: string;
  placeholder: string;
  // Rejects with the message to show if sending fails.
  onSubmit: (message: NewMessage) => Promise<void>;
  autoFocus?: boolean;
};

export function Composer({ members, submitLabel, placeholder, onSubmit, autoFocus }: ComposerProps) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ body: text.trim(), mentions });
      setText("");
      setMentions([]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 p-3">
      <MentionTextarea
        text={text}
        mentions={mentions}
        members={members}
        onChange={(nextText, nextMentions) => {
          setText(nextText);
          setMentions(nextMentions);
        }}
        onSubmit={submit}
        placeholder={placeholder}
        autoFocus={autoFocus}
        label={placeholder}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-graphite">{members.length > 0 ? "Type @ to mention someone" : ""}</span>
        <Button size="sm" loading={busy} disabled={!text.trim()} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
