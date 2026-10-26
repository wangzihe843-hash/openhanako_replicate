import { redactLogText } from "../../shared/log-redactor.ts";

/** Numeric business codes are kept separate from diagnostic text. */
export class WechatApiError extends Error {
  readonly sessionExpired: boolean;
  readonly code: string;
  readonly ret?: number;
  readonly errcode?: number;

  constructor(endpoint: string, ret?: number, errcode?: number, errmsg?: string, code?: string) {
    super(redactLogText(`${endpoint} ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${errmsg ?? ""}`));
    this.name = "WechatApiError";
    this.ret = ret;
    this.errcode = errcode;
    this.sessionExpired = ret === -14 || errcode === -14;
    this.code = code ?? (this.sessionExpired ? "WECHAT_SESSION_EXPIRED" : "WECHAT_API_ERROR");
  }
}

interface WechatApiResponse extends Record<string, unknown> {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: unknown[];
  get_updates_buf?: string;
  typing_ticket?: string;
  upload_param?: string;
}

export function assertWechatApiResponse(endpoint: string, json: unknown): asserts json is WechatApiResponse {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new WechatApiError(endpoint, undefined, undefined, "invalid response object", "WECHAT_PROTOCOL_ERROR");
  }
  const data = json as Record<string, unknown>;
  // Fixed 2.4.10 types declare errcode only on getupdates. Keep the existing
  // ret check for all current endpoints; do not infer codes from errmsg.
  const fields = endpoint === "ilink/bot/getupdates" ? ["ret", "errcode"] : ["ret"];
  const ret = Number.isInteger(data.ret) ? data.ret as number : undefined;
  const errcode = fields.includes("errcode") && Number.isInteger(data.errcode) ? data.errcode as number : undefined;
  const errmsg = typeof data.errmsg === "string" ? data.errmsg : "";
  // An authoritative numeric terminal code wins over a malformed companion.
  // Never coerce strings or retain malformed fields on the structured error.
  if (ret === -14 || errcode === -14) throw new WechatApiError(endpoint, ret, errcode, errmsg);
  for (const field of fields) {
    if (data[field] !== undefined && (typeof data[field] !== "number" || !Number.isInteger(data[field]))) {
      throw new WechatApiError(endpoint, undefined, undefined, `invalid ${field}`, "WECHAT_PROTOCOL_ERROR");
    }
  }
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    throw new WechatApiError(endpoint, ret, errcode, errmsg);
  }
}

export async function readWechatApiResponse(endpoint: string, response: Response) {
  const text = await response.text();
  if (!response.ok) throw new Error(redactLogText(`${endpoint} HTTP ${response.status}: ${text}`));
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`${endpoint} invalid JSON response`); }
  assertWechatApiResponse(endpoint, json);
  return json;
}
