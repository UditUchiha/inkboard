import type { Element as BoardElement } from "@inkboard/shared/types";
import {
  Check,
  Clapperboard,
  Copy,
  Download,
  Ellipsis,
  EyeOff,
  FileCode2,
  FileJson,
  FileUp,
  Workflow,
  History,
  Keyboard,
  LayoutGrid,
  LayoutTemplate,
  MessageSquare,
  Monitor,
  Moon,
  Presentation,
  Sun,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MOD } from "../constants/keys";
import { useNavigate } from "react-router";
import { IconButton } from "../../../components/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../../../components/Menu";
import type { Person } from "../../../lib/api";
import { useTheme } from "../../../providers/ThemeProvider";
import type { ThemePreference } from "../../../providers/ThemeProvider";
import { exportBoardAsJson, exportBoardAsMermaid, exportBoardAsPng, exportBoardAsSvg } from "../lib/files/exportImage";

export type Exporter = (elements: BoardElement[], name: string) => Promise<boolean>;

export interface BoardMenuProps {
  user: Person | null;
  // Set for a guest's scratch board, which lives in the browser.
  local: object | null;
  readOnly: boolean;
  isMember: boolean;
  commentsEnabled: boolean;
  showComments: boolean;
  isEmpty: boolean;
  canReplay: boolean;
  onReplay: () => void;
  canPresent: boolean;
  onPresent: () => void;
  onExport: (exporter: Exporter) => void;
  onImportFile: () => void;
  onImportMermaid: () => void;
  onCopy: () => void;
  onHistory: () => void;
  onTemplate: () => void;
  onToggleComments: () => void;
  onShortcuts: () => void;
  onHideUi: () => void;
  onClear: () => void;
}

export function BoardMenu({
  user,
  local,
  readOnly,
  isMember,
  commentsEnabled,
  showComments,
  isEmpty,
  canReplay,
  onReplay,
  canPresent,
  onPresent,
  onExport,
  onImportFile,
  onImportMermaid,
  onCopy,
  onHistory,
  onTemplate,
  onToggleComments,
  onShortcuts,
  onHideUi,
  onClear,
}: BoardMenuProps) {
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();

  return (
    <Menu
      trigger={(props) => (
        <IconButton label="Board menu" icon={Ellipsis} className="floating-panel rounded-xl" {...props} />
      )}
    >
      <MenuLabel>Export</MenuLabel>
      <MenuItem icon={Download} onSelect={() => onExport(exportBoardAsPng)}>
        Export as PNG
      </MenuItem>
      <MenuItem icon={FileCode2} onSelect={() => onExport(exportBoardAsSvg)}>
        Export as SVG
      </MenuItem>
      <MenuItem icon={FileJson} onSelect={() => onExport(exportBoardAsJson)}>
        Export board file
      </MenuItem>
      <MenuItem icon={Workflow} onSelect={() => onExport(exportBoardAsMermaid)}>
        Export as Mermaid
      </MenuItem>
      {!readOnly && (
        <>
          <MenuItem icon={FileUp} onSelect={onImportFile}>
            Import board file…
          </MenuItem>
          <MenuItem icon={Workflow} onSelect={onImportMermaid}>
            Import Mermaid…
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem
        icon={Presentation}
        onSelect={onPresent}
        disabled={!canPresent}
        hint={canPresent ? null : "Add a frame"}
      >
        Present frames
      </MenuItem>
      {/* Anyone signed in who can open the board can copy it to their own boards, viewers too. */}
      {user && !local && (
        <MenuItem icon={Copy} onSelect={onCopy}>
          Make a copy
        </MenuItem>
      )}
      {canReplay && (
        <MenuItem icon={Clapperboard} onSelect={onReplay}>
          Replay
        </MenuItem>
      )}
      {isMember && !local && (
        <>
          <MenuItem icon={History} onSelect={onHistory}>
            Version history
          </MenuItem>
          <MenuItem icon={LayoutTemplate} onSelect={onTemplate} disabled={isEmpty}>
            Save as template
          </MenuItem>
        </>
      )}
      {commentsEnabled && (
        <MenuItem
          icon={MessageSquare}
          onSelect={onToggleComments}
          hint={showComments ? <Check className="size-4" /> : null}
        >
          Show comments
        </MenuItem>
      )}
      <MenuItem icon={Keyboard} hint="?" onSelect={onShortcuts}>
        Keyboard shortcuts
      </MenuItem>
      <MenuItem icon={EyeOff} hint={`${MOD} .`} onSelect={onHideUi}>
        Hide interface
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      {(
        [
          ["light", "Light", Sun],
          ["dark", "Dark", Moon],
          ["system", "Match system", Monitor],
        ] satisfies [ThemePreference, string, LucideIcon][]
      ).map(([value, label, Icon]) => (
        <MenuItem
          key={value}
          icon={Icon}
          onSelect={() => setPreference(value)}
          hint={preference === value ? <Check className="size-4" /> : null}
        >
          {label}
        </MenuItem>
      ))}
      <MenuSeparator />
      {/* Wiping a whole board is for its members (or the guest who owns a scratch board), not link visitors. */}
      {(isMember || local) && (
        <MenuItem icon={Trash2} tone="danger" onSelect={onClear} disabled={isEmpty}>
          Clear board
        </MenuItem>
      )}
      {user && (
        <MenuItem icon={LayoutGrid} onSelect={() => navigate("/boards")}>
          All boards
        </MenuItem>
      )}
    </Menu>
  );
}
