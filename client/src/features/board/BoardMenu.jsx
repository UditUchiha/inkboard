import {
  Check,
  Download,
  Ellipsis,
  FileCode2,
  FileJson,
  FileUp,
  History,
  Keyboard,
  LayoutGrid,
  LayoutTemplate,
  MessageSquare,
  Monitor,
  Moon,
  Sun,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router";
import { IconButton } from "../../components/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../../components/Menu";
import { useTheme } from "../../providers/ThemeProvider";
import { exportBoardAsJson, exportBoardAsPng, exportBoardAsSvg } from "./exportImage";

/**
 * The "..." menu at the top right: export, import, history, templates, comments,
 * shortcuts, theme and clearing the board.
 */
export function BoardMenu({
  user,
  local,
  readOnly,
  isMember,
  commentsEnabled,
  showComments,
  isEmpty,
  onExport,
  onImportFile,
  onHistory,
  onTemplate,
  onToggleComments,
  onShortcuts,
  onClear,
}) {
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
      {!readOnly && (
        <MenuItem icon={FileUp} onSelect={onImportFile}>
          Import board file…
        </MenuItem>
      )}
      <MenuSeparator />
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
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      {[
        ["light", "Light", Sun],
        ["dark", "Dark", Moon],
        ["system", "Match system", Monitor],
      ].map(([value, label, Icon]) => (
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
