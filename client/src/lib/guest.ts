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

// What the guest is called and identified by.
export type Guest = { id: string; name: string };

let cached: Guest | null = null;

const randomId = () =>
  `g_${[...crypto.getRandomValues(new Uint8Array(12))].map((n) => (n % 36).toString(36)).join("")}`;

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
      cached = stored;
      return cached;
    }
  } catch {
    // Fall through and make a new identity.
  }
  save({ id: randomId(), name: `Guest ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}` });
  // `save` just set it (TypeScript doesn't see that through the call).
  return cached!;
}

export function setGuestName(name: string) {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40) || "Guest";
  save({ ...getGuest(), name: clean });
  return clean;
}
