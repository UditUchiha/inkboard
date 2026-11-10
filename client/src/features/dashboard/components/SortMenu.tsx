import { ArrowDownUp, Check } from "lucide-react";
import { Button } from "../../../components/Button";
import { Menu, MenuItem, MenuLabel } from "../../../components/Menu";
import { SORT_KEYS } from "../lib/sections";
import type { Sort, SortKey } from "../lib/sections";

interface SortMenuProps {
  sort: Sort;
  onChange: (sort: Sort) => void;
}

export function SortMenu({ sort, onChange }: SortMenuProps) {
  const tick = (on: boolean) => (on ? <Check className="size-4" /> : null);
  return (
    <Menu
      trigger={(props) => (
        <Button variant="secondary" icon={ArrowDownUp} {...props}>
          <span className="max-sm:sr-only">{SORT_KEYS[sort.key].label}</span>
        </Button>
      )}
    >
      <MenuLabel>Sort by</MenuLabel>
      {Object.entries(SORT_KEYS).map(([key, { label, defaultDir }]) => (
        <MenuItem
          key={key}
          hint={tick(sort.key === key)}
          onSelect={() => onChange({ key: key as SortKey, dir: defaultDir })}
        >
          {label}
        </MenuItem>
      ))}
      <MenuLabel>Order</MenuLabel>
      {(
        [
          ["asc", sort.key === "title" ? "A to Z" : "Oldest first"],
          ["desc", sort.key === "title" ? "Z to A" : "Newest first"],
        ] as const
      ).map(([dir, label]) => (
        <MenuItem key={dir} hint={tick(sort.dir === dir)} onSelect={() => onChange({ ...sort, dir })}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  );
}
