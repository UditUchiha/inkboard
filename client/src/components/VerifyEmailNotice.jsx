import clsx from "clsx";
import { MailCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuth } from "../providers/AuthProvider";
import { Button } from "./Button";
import { useEmailEnabled } from "./OAuthButtons";

/**
 * Asks someone who hasn't verified their email to do so, with a way to get a
 * new link. Shows nothing once the address is verified, or while email isn't set up.
 */
export function VerifyEmailNotice({ className }) {
  const { user } = useAuth();
  const emailEnabled = useEmailEnabled();
  const [sending, setSending] = useState(false);
  if (!user || user.emailVerified || !emailEnabled) return null;

  async function resend() {
    setSending(true);
    try {
      await api.resendVerification();
      toast.success(`We sent a new link to ${user.email}.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="status"
      className={clsx("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-signal/30 bg-signal/8 px-4 py-3 text-sm", className)}
    >
      <MailCheck className="size-4 shrink-0 text-signal" aria-hidden />
      <p className="min-w-0 flex-1">
        Verify <strong className="font-semibold">{user.email}</strong> so people can invite you to their boards. The link is in your
        inbox (check spam too).
      </p>
      <Button variant="secondary" size="sm" loading={sending} onClick={resend}>
        Send a new link
      </Button>
    </div>
  );
}
