/** The sender written by the user channel route, after runtime name/locale resolution. */
export function getChannelUserName(engine: { readonly userName?: string }): string {
  return engine.userName || "user";
}
