// navigator.platform is deprecated; userAgentData isn't in TypeScript's DOM types yet, hence the cast.
const platform =
  typeof navigator === "undefined"
    ? ""
    : ((navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
      navigator.userAgent);
export const isMac = /Mac|iPhone|iPad/.test(platform);
export const MOD = isMac ? "⌘" : "Ctrl";
