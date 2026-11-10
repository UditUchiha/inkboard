import { MOD } from "../constants/keys";

interface HiddenUiPillProps {
  onShow: () => void;
}

// The one control left when the interface is hidden, so a mouse-only person can find the way back.
export function HiddenUiPill({ onShow }: HiddenUiPillProps) {
  return (
    <button
      type="button"
      onClick={onShow}
      className="floating-panel absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-medium text-graphite opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
    >
      Show interface <kbd className="ml-1 font-sans">{MOD} .</kbd>
    </button>
  );
}
