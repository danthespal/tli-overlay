// Local paths. Override with the TLI_LOG_DIR environment variable.
export const LOG_DIR =
  process.env.TLI_LOG_DIR ??
  "D:/SteamLibrary/steamapps/common/Torchlight Infinite/UE_game/TorchLight/Saved/Logs";

/** Steam F12 screenshots for Torchlight: Infinite (app 1974050). Override with TLI_SCREENSHOT_DIR. */
export const SCREENSHOT_DIR =
  process.env.TLI_SCREENSHOT_DIR ??
  "C:/Program Files (x86)/Steam/userdata/<steam-user-id>/760/remote/1974050/screenshots";

/** Known item ids (ConfigBaseId). Full names will come from an item table later. */
export const KNOWN_ITEMS: Record<number, string> = {
  100300: "Flame Elementium",
  100200: "Flame Sand",
  5140: "Memory Scrap",
  5141: "Memory Thread - Normal (unconfirmed)",
  5142: "Memory Thread - Magic",
  5143: "Memory Thread - Rare",
  5144: "Memory Thread - Epic",
  6007: "Lost Secrets",
  10011: "Lavish Novel Compass",
  200028: "Precious Ember",
  410201: "Void Sea Invitation - Craving",
  410202: "Void Sea Invitation - Ecstasy",
  410203: "Void Sea Invitation - Sorrow",
  10022: "Soldier Compass",
  200029: "Matchless Ember",
  10042: "Elite Compass",
  71001: "Memory of Origin",
  71002: "Memory of Discipline",
  71003: "Memory of Progress",
};
