/**
 * Local notification wrappers. Notifications are informational: the action a
 * notification offers is always executed server-side (`action-dispatch`), never
 * by the client staying alive. Outside Tauri the Web Notification API is used
 * when present, otherwise calls are no-ops.
 */
import { isPermissionGranted, requestPermission as tauriRequestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./tauri.ts";

export interface NotifyOptions {
  readonly title: string;
  readonly body?: string;
}

export async function requestPermission(): Promise<boolean> {
  if (isTauri()) {
    if (await isPermissionGranted()) return true;
    return (await tauriRequestPermission()) === "granted";
  }
  const api = globalThis.Notification;
  if (typeof api === "undefined") return false;
  if (api.permission === "granted") return true;
  if (api.permission === "denied") return false;
  return (await api.requestPermission()) === "granted";
}

/** Shows a notification if permitted; resolves false when it could not be shown. */
export async function notify(options: NotifyOptions): Promise<boolean> {
  if (!(await requestPermission())) return false;
  if (isTauri()) {
    sendNotification(options.body !== undefined ? { title: options.title, body: options.body } : { title: options.title });
    return true;
  }
  try {
    new globalThis.Notification(options.title, options.body !== undefined ? { body: options.body } : {});
    return true;
  } catch {
    return false;
  }
}
