import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../components/Button";
import { TextField } from "../../components/Field";
import { errorMessage } from "../../lib/api";

/** Asks for the password a board's link asks for. `onUnlock` gives it to the server, and rejects if it's wrong. */
export function LinkPasswordForm({ onUnlock }: { onUnlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setChecking(true);
    try {
      await onUnlock(password);
    } catch (unlockError) {
      setError(errorMessage(unlockError));
      setChecking(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-6 grid max-w-xs gap-3 text-left">
      <TextField
        label="Password"
        type="password"
        autoComplete="off"
        autoFocus
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={error}
        required
      />
      <Button type="submit" loading={checking}>
        Open board
      </Button>
    </form>
  );
}
