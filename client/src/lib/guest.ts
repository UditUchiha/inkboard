// Signed-out visitors get a random id and a friendly name, kept in this browser,
// so their cursor and presence look the same every time they open a shared board.

const GUEST_KEY = "inkboard.guest";
const ANIMALS = [
  "Otter",
  "Fox",
  "Heron",
  "Badger",
  "Lynx",
  "Panda",
  "Koala",
  "Falcon",
  "Moose",
  "Gecko",
  "Orca",
  "Wombat",
];

// What the guest is called and identified by, and the key that proves the id is theirs (sent only to the server when
// connecting: the id is shown to others, the key never is).
export type Guest = { id: string; name: string; key: string };

let cached: Guest | null = null;

const randomId = () =>
  `g_${[...crypto.getRandomValues(new Uint8Array(12))].map((n) => (n % 36).toString(36)).join("")}`;
const randomKey = () =>
  [...crypto.getRandomValues(new Uint8Array(24))].map((n) => n.toString(16).padStart(2, "0")).join("");

function save(guest: Guest) {
  cached = guest;
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    // Storage unavailable: the identity lasts until reload.
  }
}

export function getGuest(): Guest {
  if (cached) return cached;
  try {
    // Checked below before it's used.
    const stored: Guest | null = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "null");
    if (stored?.id && stored?.name) {
      // A guest from before keys keeps their id, with a key from now on.
      if (stored.key) cached = stored;
      else save({ ...stored, key: randomKey() });
      // `save` sets it when it isn't already.
      return cached!;
    }
  } catch {
    // Fall through and make a new identity.
  }
  save({ id: randomId(), name: `Guest ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`, key: randomKey() });
  // `save` just set it (TypeScript doesn't see that through the call).
  return cached!;
}

export function setGuestName(name: string) {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40) || "Guest";
  save({ ...getGuest(), name: clean });
  return clean;
}
