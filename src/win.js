// Events for this window only. The backend sends each window just the output
// of what that window started (its program, language servers, debugger,
// terminals), so two windows never see each other's.
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const me = getCurrentWebviewWindow();
export const winLabel = me.label;
export const on = (event, handler) => me.listen(event, handler);
