import type { AccountUser } from "../../../lib/api";
import type { AuthValue } from "../../../providers/AuthProvider";

export type SignedIn = AuthValue & { user: AccountUser };
